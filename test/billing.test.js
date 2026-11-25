const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPaymentStore } = require('../services/payment-store');
const { createBillingService } = require('../services/billing-service');
const { quote, demoQuote } = require('../services/storefront-quote');
const { nextDate } = require('../services/billing-schedule');

function fixture(t) {
  const store = createPaymentStore(':memory:'); t.after(() => store.close());
  let time = new Date('2026-01-31T12:00:00Z');
  const sales = [], creates = [], cancellations = [], customers = new Map(), subscriptions = new Map();
  const missing = () => { throw Object.assign(new Error('Not found'), { type: 'notFoundError' }); };
  const gateway = {
    merchantAccount: { all: callback => callback(null, [{ id: 'gbp', default: true, currencyIsoCode: 'GBP' }]) },
    customer: { find: async id => customers.get(id) || missing(), create: async data => { customers.set(data.id, data); return { success: true, customer: data }; } },
    paymentMethodNonce: {
      find: async nonce => ({ type: nonce.startsWith('card') ? 'CreditCard' : nonce.startsWith('apple') ? 'ApplePayCard' : nonce.startsWith('google') ? 'AndroidPayCard' : 'PayPalAccount', details: { isNetworkTokenized: nonce === 'google-network' }, threeDSecureInfo: { liabilityShifted: nonce === 'card-verified' || nonce === 'google-verified' } }),
      create: async () => ({ paymentMethodNonce: { nonce: 'card-verified', details: { bin: '411111' } } }),
    },
    paymentMethod: { create: async data => ({ success: true, paymentMethod: { token: `vault-${data.customerId}`, email: 'buyer@example.test', customerId: data.customerId } }), delete: async () => ({ success: true }) },
    plan: { all: async () => [{ id: 'monthly-gbp', billingFrequency: 1, currencyIsoCode: 'GBP' }], create: async data => ({ success: true, plan: data }) },
    subscription: {
      find: async id => subscriptions.get(id) || missing(),
      create: async data => { creates.push(data); const subscription = { ...data, status: 'Pending', nextBillingDate: data.firstBillingDate }; subscriptions.set(data.id, subscription); return { success: true, subscription }; },
      cancel: async id => { cancellations.push(id); const value = subscriptions.get(id); if (value) value.status = 'Canceled'; return { success: true }; },
      update: async (id, data) => { Object.assign(subscriptions.get(id), data); return { success: true }; },
      retryCharge: async () => ({ success: true, transaction: { id: 'native-retry', amount: '8.00', status: 'submitted_for_settlement' } }),
    },
    transaction: { sale: async data => {
      sales.push(data);
      if (data.paymentMethodNonce === 'declined') return { success: false, message: 'Declined' };
      const token = `vault-${data.customerId || 'existing'}`;
      return { success: true, transaction: { id: `tx-${sales.length}`, amount: data.amount, status: 'submitted_for_settlement', creditCard: { token, cardType: 'Visa', last4: '1111' }, paypalAccount: { token, payerEmail: 'buyer@example.test' } } };
    } },
  };
  const billing = createBillingService({ gateway, store, now: () => time });
  function prepared(selection) { return { ...quote(selection), id: `quote-${Math.random().toString(36).slice(2)}`, createdAt: time.getTime() }; }
  async function start(selection, owner = 'owner-a') { const checkout = prepared(selection); const receipt = await billing.checkout({ prepared: checkout, owner, nonce: 'paypal-new', billingConsent: true }); return { receipt, agreement: store.get('agreement', receipt.agreementId), checkout }; }
  return { store, gateway, billing, sales, creates, cancellations, subscriptions, prepared, start, advance: value => { time = new Date(value); } };
}

test('monthly fixed plans vault the method and start future native billing without a duplicate initial charge', async t => {
  const f = fixture(t);
  const { agreement, receipt, checkout } = await f.start({ kind: 'plan', planId: 'basic', contractLengthId: '12month' });
  assert.equal(f.sales.length, 1); assert.equal(f.sales[0].amount, '7.60');
  assert.equal(f.sales[0].options.storeInVaultOnSuccess, true);
  assert.equal(f.sales[0].transactionSource, 'recurring_first');
  assert.equal(f.creates.length, 1); assert.equal(f.creates[0].price, '7.60');
  assert.equal(f.creates[0].numberOfBillingCycles, 11); assert.equal(f.creates[0].firstBillingDate, '2026-02-28');
  assert.equal(agreement.status, 'active'); assert.equal(agreement.engine, 'braintree');
  assert.match(f.store.get('method', agreement.methodId).token, /^vault-/);
  assert.doesNotMatch(JSON.stringify(f.billing.summary('owner-a')), /vault-|paymentMethodToken/);
  assert.deepEqual(await f.billing.checkout({ prepared: checkout, owner: 'owner-a', nonce: 'paypal-new', billingConsent: true }), JSON.parse(JSON.stringify(receipt)));
  assert.equal(f.sales.length, 1); assert.equal(f.creates.length, 1);
});

test('variable billing saves a payment method without charging, then bills actual usage once', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'variable' });
  assert.equal(f.sales.length, 0); assert.equal(agreement.billing.initialPence, 0);
  await f.billing.recordUsage('owner-a', agreement.id, { minutes: 10, texts: 10, dataMB: 100, eventId: 'usage-event-1' });
  await f.billing.recordUsage('owner-a', agreement.id, { minutes: 10, texts: 10, dataMB: 100, eventId: 'usage-event-1' });
  assert.equal(f.store.get('agreement', agreement.id).accruedPence, 150);
  f.advance('2026-02-28T12:00:00Z'); await f.billing.tick(); await f.billing.tick();
  assert.equal(f.sales.length, 1); assert.equal(f.sales[0].amount, '1.50'); assert.equal(f.sales[0].transactionSource, 'unscheduled');
  assert.ok(f.sales[0].paymentMethodToken); assert.equal(f.store.get('agreement', agreement.id).accruedPence, 0);
  assert.equal(f.store.get('agreement', agreement.id).nextDue, '2026-03-31T12:00:00.000Z');
});

test('empty usage periods advance without a charge and usage cannot exceed its authorized limit', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'variable' });
  await assert.rejects(f.billing.recordUsage('owner-a', agreement.id, { dataMB: 2001, eventId: 'over-limit-1' }), /limit/);
  f.advance('2026-02-28T12:00:00Z'); await f.billing.tick(); assert.equal(f.sales.length, 0);
  assert.equal(f.store.get('agreement', agreement.id).nextDue, '2026-03-31T12:00:00.000Z');
});

test('prepaid usage triggers a real vaulted top-up and replaying the usage event cannot charge again', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'autotopup' });
  await f.billing.recordUsage('owner-a', agreement.id, { dataMB: 1200, eventId: 'prepaid-usage-1' });
  assert.equal(f.sales.length, 2); assert.equal(f.sales[1].amount, '20.00'); assert.equal(f.sales[1].transactionSource, 'unscheduled');
  assert.equal(f.store.get('agreement', agreement.id).balancePence, 2800);
  await f.billing.recordUsage('owner-a', agreement.id, { dataMB: 1200, eventId: 'prepaid-usage-1' });
  assert.equal(f.sales.length, 2);
  await assert.rejects(f.billing.recordUsage('owner-a', agreement.id, { dataMB: 3000, eventId: 'too-much-usage' }), /credit/);
});

test('a declined top-up pauses billing and only an explicit retry charges again', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'autotopup' });
  const success = f.gateway.transaction.sale;
  let declined = 0; f.gateway.transaction.sale = async () => { declined++; return { success: false }; };
  await f.billing.recordUsage('owner-a', agreement.id, { dataMB: 1200, eventId: 'declined-usage-1' });
  await f.billing.tick(); assert.equal(declined, 1); assert.equal(f.store.get('agreement', agreement.id).status, 'past_due');
  f.gateway.transaction.sale = success; await f.billing.retry('owner-a', agreement.id);
  assert.equal(f.store.get('agreement', agreement.id).balancePence, 2800); assert.equal(f.store.get('agreement', agreement.id).status, 'active');
});

test('installments stop after the agreed number of payments', async t => {
  const f = fixture(t);
  const prepared = { ...demoQuote({ type: 'installments', description: 'Two payments', amount: '5.00', installments: 2, frequency: 'weekly' }), id: 'weekly-installments' };
  const receipt = await f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new', billingConsent: true });
  f.advance('2026-02-07T12:00:00Z'); await f.billing.tick();
  assert.equal(f.sales.length, 2); assert.equal(f.sales[1].transactionSource, 'installment');
  assert.equal(f.store.get('agreement', receipt.agreementId).status, 'completed');
  f.advance('2026-03-07T12:00:00Z'); await f.billing.tick(); assert.equal(f.sales.length, 2);
});

test('hybrid billing separates the initial setup fee from the recurring amount', async t => {
  const f = fixture(t);
  const prepared = { ...demoQuote({ type: 'hybrid', description: 'Phone bundle', oneTimeAmount: '10', recurringAmount: '20', frequency: 'monthly' }), id: 'hybrid-quote' };
  await f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new', billingConsent: true });
  assert.equal(f.sales[0].amount, '30.00'); assert.equal(f.creates[0].price, '20.00');
});

test('cancellation stops merchant billing and native cancellation survives a late active webhook', async t => {
  const f = fixture(t); const fixed = await f.start({ kind: 'plan', planId: 'basic' });
  await f.billing.cancel('owner-a', fixed.agreement.id);
  assert.equal(f.cancellations.length, 1);
  await f.billing.webhook({ subscription: { id: fixed.agreement.nativeId, status: 'Active' } });
  assert.equal(f.store.get('agreement', fixed.agreement.id).status, 'cancelled');
  const variable = await f.start({ kind: 'plan', planId: 'variable' });
  await f.billing.cancel('owner-a', variable.agreement.id);
  await assert.rejects(f.billing.recordUsage('owner-a', variable.agreement.id, { texts: 5, eventId: 'after-cancel' }), /cannot accept/);
});

test('failed native setup is reconciled without charging the first payment twice', async t => {
  const f = fixture(t); const success = f.gateway.subscription.create; let attempts = 0;
  f.gateway.subscription.create = async () => { attempts++; throw new Error('Interrupted'); };
  const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  assert.equal(f.store.get('agreement', agreement.id).status, 'setup_pending'); assert.equal(f.sales.length, 1);
  f.gateway.subscription.create = success; await f.billing.tick();
  assert.equal(f.store.get('agreement', agreement.id).status, 'active'); assert.equal(f.sales.length, 1); assert.equal(attempts, 1);
});

test('uncertain charge outcomes are visible and never automatically resubmitted', async t => {
  const f = fixture(t); let attempts = 0; f.gateway.transaction.sale = async () => { attempts++; throw new Error('Connection lost'); };
  const prepared = f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' });
  await assert.rejects(f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new' }), /interrupted/);
  await assert.rejects(f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new' }), /already processing|review/);
  assert.equal(attempts, 1); assert.equal(f.billing.summary('owner-a').payments[0].status, 'review');
});

test('a concurrent checkout cannot submit the same quote twice', async t => {
  const f = fixture(t); let finish, started;
  const entered = new Promise(resolve => { started = resolve; }); const success = f.gateway.transaction.sale;
  f.gateway.transaction.sale = async data => { started(); await new Promise(resolve => { finish = resolve; }); return success(data); };
  const prepared = f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' });
  const first = f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new' });
  await entered;
  await assert.rejects(f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new' }), /already processing/);
  finish(); await first; assert.equal(f.sales.length, 1);
});

test('saved methods, agreements and usage are isolated to the owning customer', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  assert.deepEqual(f.billing.summary('owner-b'), { methods: [], agreements: [], payments: [] });
  await assert.rejects(f.billing.cancel('owner-b', agreement.id), /not found/);
  await assert.rejects(f.billing.savedNonce('owner-b', agreement.methodId), /not found/);
  await assert.rejects(f.billing.removeMethod('owner-b', agreement.methodId), /not found/);
  const prepared = f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' });
  await assert.rejects(f.billing.checkout({ prepared, owner: 'owner-b', savedMethodId: agreement.methodId }), /not found/);
});

test('saved PayPal methods can be reused and cannot be removed while a plan uses them', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  await assert.rejects(f.billing.removeMethod('owner-a', agreement.methodId), /Cancel or change/);
  const prepared = f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' });
  await f.billing.checkout({ prepared, owner: 'owner-a', savedMethodId: agreement.methodId });
  assert.ok(f.sales.at(-1).paymentMethodToken); assert.equal(f.sales.at(-1).paymentMethodNonce, undefined);
  await f.billing.cancel('owner-a', agreement.id); await f.billing.removeMethod('owner-a', agreement.methodId);
  assert.equal(f.billing.summary('owner-a').methods.length, 0);
});

test('recurring consent is required before vaulting or charging', async t => {
  const f = fixture(t); const prepared = f.prepared({ kind: 'plan', planId: 'basic' });
  await assert.rejects(f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new' }), /Confirm/);
  assert.equal(f.sales.length, 0); assert.equal(f.store.list('method').length, 0);
});

test('Apple Pay and network-tokenized Google Pay use Braintree; non-network Google Pay requires 3DS', async t => {
  const f = fixture(t);
  for (const nonce of ['apple-approved', 'google-network', 'google-verified']) await f.billing.checkout({ prepared: f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' }), owner: 'owner-a', nonce });
  assert.equal(f.sales.length, 3);
  await assert.rejects(f.billing.checkout({ prepared: f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' }), owner: 'owner-a', nonce: 'google-unverified' }), /authentication/);
  assert.equal(f.sales.length, 3);
});

test('native billing notifications add transaction history without charging from the webhook', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  const notification = { subscription: { id: agreement.nativeId, status: 'Active', nextBillingDate: '2026-03-31', transactions: [{ id: 'native-charge-1', amount: '8.00', type: 'sale', status: 'settled', createdAt: '2026-02-28' }] } };
  await f.billing.webhook(notification); await f.billing.webhook(notification);
  assert.equal(f.sales.length, 1); assert.equal(f.billing.summary('owner-a').payments.filter(value => value.id === 'native-charge-1').length, 1);
});

test('month-end scheduling retains the original billing day through short months', () => {
  const february = nextDate('2026-01-31T12:00:00Z', 'monthly', 31);
  assert.equal(february, '2026-02-28T12:00:00.000Z'); assert.equal(nextDate(february, 'monthly', 31), '2026-03-31T12:00:00.000Z');
  assert.equal(nextDate('2024-02-29T12:00:00Z', 'yearly', 29), '2025-02-28T12:00:00.000Z');
});

test('billing records, operation claims and session identity survive reopening the database', t => {
  const directory = fs.mkdtempSync('/private/tmp/presentment-billing-test-'); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'payments.sqlite'); let store = createPaymentStore(filename); const secret = store.secret();
  store.put('method', 'saved', 'owner-a', { token: 'test-vault-token' }); assert.equal(store.claim('payment-once'), true); store.finish('payment-once', 'succeeded', { id: 'tx' }); store.close();
  store = createPaymentStore(filename); t.after(() => store.close());
  assert.equal(store.secret(), secret); assert.equal(store.get('method', 'saved', 'owner-a').token, 'test-vault-token');
  assert.equal(store.get('method', 'saved', 'owner-b'), undefined); assert.equal(store.claim('payment-once'), false);
});

test('a lost native-creation response is reconciled by its deterministic subscription ID', async t => {
  const f = fixture(t); const create = f.gateway.subscription.create;
  f.gateway.subscription.create = async data => { await create(data); throw new Error('Response lost'); };
  const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  assert.equal(f.store.get('agreement', agreement.id).status, 'setup_pending');
  await f.billing.tick();
  assert.equal(f.store.get('agreement', agreement.id).status, 'active'); assert.equal(f.creates.length, 1); assert.equal(f.sales.length, 1);
});

test('a lost cancellation response does not leave an already-cancelled native plan pending', async t => {
  const f = fixture(t); const { agreement } = await f.start({ kind: 'plan', planId: 'basic' });
  const cancel = f.gateway.subscription.cancel;
  f.gateway.subscription.cancel = async id => { await cancel(id); throw new Error('Response lost'); };
  await f.billing.cancel('owner-a', agreement.id);
  assert.equal(f.store.get('agreement', agreement.id).status, 'cancel_pending');
  await f.billing.tick();
  assert.equal(f.store.get('agreement', agreement.id).status, 'cancelled'); assert.equal(f.cancellations.length, 1);
});

test('an owned saved method can authorize a zero-upfront usage plan without a new nonce', async t => {
  const f = fixture(t); const fixed = await f.start({ kind: 'plan', planId: 'basic' });
  const prepared = f.prepared({ kind: 'plan', planId: 'variable' });
  f.gateway.paymentMethod.create = async () => { throw new Error('A new method should not be created'); };
  const count = f.sales.length;
  const receipt = await f.billing.checkout({ prepared, owner: 'owner-a', savedMethodId: fixed.agreement.methodId, billingConsent: true });
  assert.equal(receipt.isSetupOnly, true); assert.equal(f.sales.length, count);
  assert.equal(f.store.get('agreement', receipt.agreementId).methodId, fixed.agreement.methodId);
});

test('two checkout quotes for the same basket cannot charge concurrently or after completion', async t => {
  const f = fixture(t); let finish, started;
  const entered = new Promise(resolve => { started = resolve; }); const sale = f.gateway.transaction.sale;
  f.gateway.transaction.sale = async data => { started(); await new Promise(resolve => { finish = resolve; }); return sale(data); };
  const first = { ...f.prepared({ kind: 'device', deviceId: 'iphone-16-pro' }), kind: 'cart', cartVersion: 'same-basket' };
  const second = { ...first, id: 'another-quote-for-same-basket' };
  const pending = f.billing.checkout({ prepared: first, owner: 'owner-a', nonce: 'paypal-new' });
  await entered;
  await assert.rejects(f.billing.checkout({ prepared: second, owner: 'owner-a', nonce: 'paypal-new' }), /basket is already processing/);
  finish(); const receipt = await pending;
  assert.equal((await f.billing.checkout({ prepared: second, owner: 'owner-a', nonce: 'paypal-new' })).quoteId, receipt.quoteId);
  assert.equal(f.sales.length, 1);
});

test('yearly billing uses a yearly plan even when a monthly plan override is configured', async t => {
  const previous = process.env.BRAINTREE_BILLING_PLAN_ID;
  process.env.BRAINTREE_BILLING_PLAN_ID = 'configured-monthly-plan';
  t.after(() => { if (previous === undefined) delete process.env.BRAINTREE_BILLING_PLAN_ID; else process.env.BRAINTREE_BILLING_PLAN_ID = previous; });
  const f = fixture(t);
  const prepared = { ...demoQuote({ type: 'subscription', description: 'Annual plan', amount: '24.00', frequency: 'yearly' }), id: 'yearly-quote' };
  await f.billing.checkout({ prepared, owner: 'owner-a', nonce: 'paypal-new', billingConsent: true });
  assert.equal(f.creates[0].planId, 'presentment_gbp_12m');
  assert.equal(f.creates[0].price, '24.00'); assert.equal(f.creates[0].firstBillingDate, '2027-01-31');
});
