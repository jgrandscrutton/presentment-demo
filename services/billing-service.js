const { randomUUID, createHash } = require('node:crypto');
const { nextDate } = require('./billing-schedule');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
const pounds = pence => (pence / 100).toFixed(2);
const notFound = error => error?.type === 'notFoundError' || error?.name === 'NotFoundError' || error?.statusCode === 404;

function createBillingService({ gateway, store, now = () => new Date() }) {
  let accountPromise;
  let running = false;

  async function merchantAccount() {
    if (!accountPromise) accountPromise = (async () => {
      const account = process.env.MERCHANT_ACCOUNT_ID
        ? await gateway.merchantAccount.find(process.env.MERCHANT_ACCOUNT_ID)
        : (await new Promise((resolve, reject) => gateway.merchantAccount.all((error, accounts) => error ? reject(error) : resolve(accounts)))).find(item => item.default);
      if (!account || account.currencyIsoCode !== 'GBP') fail('Set MERCHANT_ACCOUNT_ID in .env to a GBP Braintree merchant account.', 503);
      return account;
    })().catch(error => { accountPromise = undefined; throw error; });
    return accountPromise;
  }

  async function customer(owner, email) {
    let record = store.get('customer', owner, owner);
    if (record?.ready) return record;
    record ||= { id: `ps_${owner.replace(/-/g, '').slice(0, 30)}`, owner, email };
    store.put('customer', owner, owner, record);
    try { await gateway.customer.find(record.id); }
    catch (error) {
      if (!notFound(error)) throw error;
      const result = await gateway.customer.create({ id: record.id, ...(email ? { email } : {}) });
      if (!result.success) fail(result.message || 'Could not create your Braintree customer.', 502);
    }
    record.ready = true;
    return store.put('customer', owner, owner, record);
  }

  function saveMethod(owner, details, type, customerId) {
    const token = details?.token || details?.implicitlyVaultedPaymentMethodToken;
    if (!token) fail('Braintree did not return a saved payment method. Check the successful payment in Billing before trying again.', 502);
    const id = createHash('sha256').update(`${owner}:${token}`).digest('hex').slice(0, 24);
    return store.put('method', id, owner, { id, owner, token, type, customerId, label: type === 'PayPalAccount' ? `PayPal${details.email || details.payerEmail ? ` · ${details.email || details.payerEmail}` : ''}` : `${details.cardType || 'Card'} ··${details.last4 || 'saved'}`, removed: false });
  }

  async function nativePlan(frequency) {
    const interval = frequency === 'yearly' ? 12 : 1;
    if (process.env.BRAINTREE_BILLING_PLAN_ID && interval === 1) {
      const plan = await gateway.plan.find(process.env.BRAINTREE_BILLING_PLAN_ID);
      if (plan.currencyIsoCode !== 'GBP' || Number(plan.billingFrequency) !== interval) fail('BRAINTREE_BILLING_PLAN_ID must match the GBP billing interval.', 503);
      return plan;
    }
    const plans = await gateway.plan.all();
    const existing = plans.find(plan => plan.currencyIsoCode === 'GBP' && Number(plan.billingFrequency) === interval);
    if (existing) return existing;
    const id = `presentment_gbp_${interval}m`;
    const result = await gateway.plan.create({ id, name: `Presentment ${interval}-month billing`, price: '1.00', billingFrequency: interval, currencyIsoCode: 'GBP' });
    if (!result.success) fail(result.message || 'Enable recurring billing in Braintree before starting this plan.', 503);
    return result.plan;
  }

  async function setupNative(agreement) {
    const lock = store.lock(`setup:${agreement.id}`);
    if (!lock) return;
    try {
      const current = store.get('agreement', agreement.id);
      if (!['setup_pending', 'cancel_pending'].includes(current.status)) return;
      let subscription;
      try { subscription = await gateway.subscription.find(current.nativeId); }
      catch (error) { if (!notFound(error)) throw error; }
      if (!subscription && current.status === 'cancel_pending') {
        current.status = 'cancelled';
      } else if (current.status === 'cancel_pending') {
        if (!['Canceled', 'Expired'].includes(subscription.status)) {
          const result = await gateway.subscription.cancel(current.nativeId);
          if (!result.success) fail(result.message || 'Cancellation could not be confirmed.', 502);
        }
        current.status = 'cancelled';
      } else {
        if (!subscription) {
          const method = store.get('method', current.methodId, current.owner);
          const result = await gateway.subscription.create({
            id: current.nativeId, planId: current.nativePlanId, paymentMethodToken: method.token,
            merchantAccountId: current.merchantAccountId, price: pounds(current.billing.amountPence),
            firstBillingDate: current.nextDue.slice(0, 10), trialPeriod: false,
            ...(current.billing.cycles ? { numberOfBillingCycles: current.billing.cycles - 1 } : { neverExpires: true }),
            options: { doNotInheritAddOnsOrDiscounts: true },
          });
          if (!result.success) fail(result.message || 'Recurring billing setup is pending.', 502);
          subscription = result.subscription;
        }
        current.status = ['Canceled', 'Expired'].includes(subscription.status) ? subscription.status === 'Canceled' ? 'cancelled' : 'completed' : 'active';
        current.nextDue = subscription.nextBillingDate ? new Date(subscription.nextBillingDate).toISOString() : current.nextDue;
      }
      current.lastError = undefined;
      store.update('agreement', current.id, current.owner, value => ({ ...current, status: value.status === 'cancel_pending' && current.status === 'active' ? 'cancel_pending' : current.status }));
    } catch {
      store.update('agreement', agreement.id, agreement.owner, value => ({ ...value, lastError: 'Braintree has not confirmed the subscription change. It will be reconciled automatically; your initial payment will not be repeated.' }));
    } finally { store.unlock(`setup:${agreement.id}`, lock); }
  }

  async function checkout({ prepared, owner, nonce, savedMethodId, savePaymentMethod = false, billingConsent = false, email }) {
    if (prepared.billing && billingConsent !== true) fail('Confirm the recurring billing terms before continuing.');
    const operationId = `checkout:${prepared.id}`;
    const previous = store.operation(operationId);
    if (previous?.state === 'succeeded') return previous.data;
    if (prepared.kind === 'cart' && !prepared.cartVersion) fail('Refresh your basket before checking out.', 409);
    const resourceId = prepared.kind === 'cart' ? `basket:${owner}:${prepared.cartVersion}` : undefined;
    if (resourceId) {
      const paidBasket = store.operation(resourceId);
      if (paidBasket?.state === 'succeeded') {
        const receipt = store.get('receipt', paidBasket.data.quoteId, owner);
        if (receipt) return receipt;
        fail('This basket requires review before retrying.', 409);
      }
      if (!store.claim(resourceId, true)) fail('This basket is already processing or needs review. Check Billing before retrying.', 409);
    }
    if (!store.claim(operationId, true)) {
      if (resourceId) store.finish(resourceId, 'review');
      fail('This payment is already processing or needs review. Check Billing before retrying.', 409);
    }
    store.put('attempt', operationId, owner, { id: operationId, owner, amount: prepared.amount, description: prepared.description, createdAt: now().toISOString(), status: 'processing' });
    let providerStarted = false;
    try {
      const account = await merchantAccount();
      let method;
      let info;
      if (savedMethodId) {
        method = store.get('method', savedMethodId, owner);
        if (!method || method.removed) fail('Saved payment method not found.', 404);
        if (method.type !== 'PayPalAccount') fail('Authenticate the saved card before using it.');
        info = { type: method.type };
      } else {
        if (typeof nonce !== 'string' || !nonce.trim()) fail('Approve a payment method before placing your order.');
        info = await gateway.paymentMethodNonce.find(nonce);
      }
      if (!['CreditCard', 'PayPalAccount', 'ApplePayCard', 'AndroidPayCard'].includes(info.type)) fail('Choose a supported payment method.');
      const requires3DS = info.type === 'CreditCard' || (info.type === 'AndroidPayCard' && info.details?.isNetworkTokenized !== true);
      if (requires3DS && !info.threeDSecureInfo?.liabilityShifted) fail('Card authentication was not completed. Please try again.');
      if (prepared.billing && ['ApplePayCard', 'AndroidPayCard'].includes(info.type)) fail('Use PayPal or a card to authorize recurring payments.');
      const shouldSave = Boolean(prepared.billing || savePaymentMethod);
      if (shouldSave && ['ApplePayCard', 'AndroidPayCard'].includes(info.type)) fail('Use a card or PayPal to save a payment method.');
      const buyer = shouldSave ? await customer(owner, email) : undefined;
      const usesNative = prepared.billing && ['subscription', 'installments', 'hybrid'].includes(prepared.billing.type) && prepared.billing.frequency !== 'weekly' && prepared.billing.cycles !== 1;
      const plan = usesNative ? await nativePlan(prepared.billing.frequency) : undefined;
      let transaction;
      if (Number(prepared.amount) === 0) {
        if (!prepared.billing) fail('A zero-value order is not supported.');
        if (!method) {
          providerStarted = true;
          const result = await gateway.paymentMethod.create({ customerId: buyer.id, paymentMethodNonce: nonce, options: { ...(requires3DS ? { verifyCard: true, verificationMerchantAccountId: account.id } : {}) } });
          if (!result.success) { store.finish(operationId, 'declined'); fail(result.message || 'Could not save your payment method.'); }
          method = saveMethod(owner, result.paymentMethod, info.type, buyer.id);
        }
      } else {
        providerStarted = true;
        const result = await gateway.transaction.sale({
          amount: prepared.amount, merchantAccountId: account.id, orderId: prepared.id,
          ...(savedMethodId ? { paymentMethodToken: method.token } : { paymentMethodNonce: nonce }),
          ...(buyer ? { customerId: buyer.id } : email ? { customer: { email } } : {}),
          ...(prepared.billing && prepared.billing.type !== 'unscheduled' ? { transactionSource: prepared.billing.type === 'installments' ? 'installment_first' : 'recurring_first' } : {}),
          options: { submitForSettlement: true, ...(shouldSave && !savedMethodId ? { storeInVaultOnSuccess: true } : {}), ...(requires3DS ? { threeDSecure: { required: true } } : {}) },
        });
        if (!result.success) { store.finish(operationId, 'declined'); fail(result.message || 'Payment was declined. Choose another payment method.'); }
        transaction = result.transaction;
        // Record a successful provider response before any follow-up vault/subscription work.
        store.put('payment', transaction.id, owner, { id: transaction.id, quoteId: prepared.id, owner, amount: prepared.amount, description: prepared.description, status: transaction.status || 'submitted_for_settlement', createdAt: now().toISOString() });
        if (shouldSave && !method) method = saveMethod(owner, transaction.paypalAccount?.token || transaction.paypalAccount?.implicitlyVaultedPaymentMethodToken ? transaction.paypalAccount : transaction.creditCard, info.type, buyer.id);
      }
      let agreement;
      if (prepared.billing) {
        const createdAt = now().toISOString();
        const id = randomUUID();
        agreement = {
          id, owner, methodId: method.id, billing: prepared.billing, merchantAccountId: account.id,
          createdAt, anchorDay: now().getUTCDate(), nextDue: prepared.billing.type === 'unscheduled' ? undefined : nextDate(createdAt, prepared.billing.frequency),
          status: usesNative ? 'setup_pending' : 'active', engine: usesNative ? 'braintree' : 'merchant',
          ...(usesNative ? { nativeId: `ps_${id.replace(/-/g, '').slice(0, 30)}`, nativePlanId: plan.id } : {}),
          paidCycles: Number(prepared.amount) > 0 ? 1 : 0, period: 1, accruedPence: 0,
          balancePence: prepared.billing.type === 'unscheduled' ? prepared.billing.initialPence : 0,
          consent: { text: prepared.consentText, at: createdAt },
        };
        store.put('agreement', id, owner, agreement);
        if (usesNative) { await setupNative(agreement); agreement = store.get('agreement', id, owner); }
      }
      const receipt = { quoteId: prepared.id, cart: prepared.items, total: prepared.amount, transactionId: transaction?.id, isSetupOnly: !transaction, agreementId: agreement?.id, billingStatus: agreement?.status, account: prepared.account, shipping: prepared.shipping, createdAt: now().toISOString() };
      store.put('receipt', prepared.id, owner, receipt);
      store.finish(operationId, 'succeeded', receipt);
      return receipt;
    } catch (error) {
      if (store.operation(operationId)?.state === 'processing') store.finish(operationId, providerStarted ? 'review' : 'declined', { message: providerStarted ? 'Payment status requires review before retrying.' : 'Payment did not start.' });
      if (providerStarted && !error.status) fail('The provider response was interrupted. Check Billing before retrying.', 502);
      throw error;
    } finally {
      const attempt = store.get('attempt', operationId, owner);
      if (attempt) store.put('attempt', operationId, owner, { ...attempt, status: store.operation(operationId)?.state || 'review' });
      if (resourceId) {
        const outcome = store.operation(operationId);
        store.finish(resourceId, outcome?.state || 'review', outcome?.state === 'succeeded' ? { quoteId: outcome.data.quoteId } : undefined);
      }
    }
  }

  async function chargeAgreement(id, { retry = false } = {}) {
    const lock = store.lock(`agreement:${id}`);
    if (!lock) return;
    try {
      let agreement = store.get('agreement', id);
      if (!agreement || agreement.engine === 'braintree' || !['active', ...(retry ? ['past_due'] : [])].includes(agreement.status)) return;
      const billing = agreement.billing;
      const topup = billing.type === 'unscheduled';
      if (topup ? agreement.balancePence >= billing.thresholdPence : new Date(agreement.nextDue) > now()) return;
      const amountPence = billing.type === 'recurring' ? agreement.accruedPence : billing.amountPence;
      if (billing.type === 'recurring' && amountPence === 0) {
        store.update('agreement', id, agreement.owner, value => ({ ...value, nextDue: nextDate(value.nextDue, billing.frequency, value.anchorDay), period: value.period + 1 }));
        return;
      }
      const operationId = `charge:${id}:${agreement.period}`;
      if (!store.claim(operationId, retry)) return;
      agreement = store.update('agreement', id, agreement.owner, value => ({ ...value, status: 'charging' }));
      try {
        const method = store.get('method', agreement.methodId, agreement.owner);
        if (!method || method.removed) fail('The saved payment method is unavailable.');
        const result = await gateway.transaction.sale({
          amount: pounds(amountPence), merchantAccountId: agreement.merchantAccountId,
          paymentMethodToken: method.token, orderId: `ps_${createHash('sha256').update(operationId).digest('hex').slice(0, 28)}`,
          transactionSource: topup || billing.type === 'recurring' ? 'unscheduled' : billing.type === 'installments' ? 'installment' : 'recurring',
          options: { submitForSettlement: true },
        });
        if (!result.success) {
          store.finish(operationId, 'declined');
          store.update('agreement', id, agreement.owner, value => ({ ...value, status: 'past_due', lastError: 'The charge was declined. Update your payment method or retry from Billing.' }));
          return;
        }
        const payment = { id: result.transaction.id, owner: agreement.owner, agreementId: id, description: billing.name, amount: pounds(amountPence), status: result.transaction.status || 'submitted_for_settlement', createdAt: now().toISOString() };
        store.put('payment', payment.id, agreement.owner, payment);
        store.finish(operationId, 'succeeded', payment);
        store.update('agreement', id, agreement.owner, value => ({
          ...value, status: billing.cycles && value.paidCycles + 1 >= billing.cycles ? 'completed' : 'active',
          paidCycles: value.paidCycles + 1, period: value.period + 1, lastError: undefined,
          balancePence: topup ? value.balancePence + amountPence : value.balancePence,
          accruedPence: billing.type === 'recurring' ? value.accruedPence - amountPence : value.accruedPence,
          nextDue: topup ? undefined : nextDate(value.nextDue, billing.frequency, value.anchorDay),
        }));
      } catch {
        store.finish(operationId, 'review');
        store.update('agreement', id, agreement.owner, value => ({ ...value, status: 'review', lastError: 'Payment status is unknown. Check Braintree before taking further action; automatic retries are stopped.' }));
      }
    } finally { store.unlock(`agreement:${id}`, lock); }
  }

  async function recordUsage(owner, id, input) {
    const units = ['minutes', 'texts', 'dataMB'].map(name => Number(input[name] || 0));
    if (units.some(value => !Number.isInteger(value) || value < 0 || value > 100000)) fail('Usage must contain non-negative whole numbers.');
    const costPence = units[0] * 3 + units[1] * 2 + units[2];
    if (!costPence) fail('Enter some usage to record.');
    const eventId = input.eventId;
    if (typeof eventId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(eventId)) fail('A unique usage event identifier is required.');
    const key = `${id}:${eventId}`;
    if (store.get('usage', key, owner)) return;
    store.update('agreement', id, owner, value => {
      if (store.get('usage', key, owner)) return value;
      if (value.status !== 'active' || !['recurring', 'unscheduled'].includes(value.billing.type)) fail('This plan cannot accept usage right now.', 409);
      if (value.billing.type === 'recurring' && value.accruedPence + costPence > value.billing.amountPence) fail('This usage exceeds the authorized billing-period limit.');
      if (value.billing.type === 'unscheduled' && costPence > value.balancePence) fail('There is not enough prepaid credit for this usage.');
      store.put('usage', key, owner, { id: key, costPence, createdAt: now().toISOString() });
      return { ...value, balancePence: value.billing.type === 'unscheduled' ? value.balancePence - costPence : value.balancePence, accruedPence: value.billing.type === 'recurring' ? value.accruedPence + costPence : value.accruedPence };
    });
    await chargeAgreement(id);
  }

  async function cancel(owner, id) {
    const agreement = store.get('agreement', id, owner);
    if (!agreement) fail('Billing agreement not found.', 404);
    if (['cancelled', 'completed'].includes(agreement.status)) return;
    const lock = store.lock(`agreement:${id}`);
    if (!lock) fail('A billing operation is in progress. Try again shortly.', 409);
    try {
      if (agreement.status === 'charging') fail('A payment is processing. Wait for its result before cancelling.', 409);
      store.update('agreement', id, owner, value => ({ ...value, status: agreement.engine === 'braintree' ? 'cancel_pending' : 'cancelled' }));
      if (agreement.engine === 'braintree') await setupNative(store.get('agreement', id, owner));
    } finally { store.unlock(`agreement:${id}`, lock); }
  }

  async function webhook(notification) {
    if (notification.subscription) {
      const subscription = notification.subscription;
      const agreement = store.list('agreement').find(value => value.nativeId === subscription.id);
      if (agreement) {
        const statuses = { Active: 'active', Pending: 'active', 'Past Due': 'past_due', Canceled: 'cancelled', Expired: 'completed' };
        store.update('agreement', agreement.id, agreement.owner, value => ({ ...value, status: ['cancelled', 'cancel_pending', 'completed'].includes(value.status) && !['Canceled', 'Expired'].includes(subscription.status) ? value.status : statuses[subscription.status] || value.status, nextDue: subscription.nextBillingDate ? new Date(subscription.nextBillingDate).toISOString() : value.nextDue }));
        for (const transaction of subscription.transactions || []) {
          if (transaction.type && transaction.type !== 'sale') continue;
          store.put('payment', transaction.id, agreement.owner, { id: transaction.id, agreementId: agreement.id, owner: agreement.owner, description: agreement.billing.name, amount: transaction.amount, status: transaction.status, createdAt: new Date(transaction.createdAt || now()).toISOString() });
        }
      }
    }
    const revoked = notification.revokedPaymentMethodMetadata?.token;
    if (revoked) for (const method of store.list('method').filter(value => value.token === revoked)) {
      store.put('method', method.id, method.owner, { ...method, removed: true });
      for (const agreement of store.list('agreement', method.owner).filter(value => value.methodId === method.id && !['completed', 'cancelled'].includes(value.status))) store.put('agreement', agreement.id, method.owner, { ...agreement, status: 'payment_method_revoked' });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const attempt of store.list('attempt').filter(value => value.status === 'processing' && now().getTime() - new Date(value.createdAt).getTime() > 120000)) {
        if (store.operation(attempt.id)?.state === 'processing') {
          store.finish(attempt.id, 'review');
          store.put('attempt', attempt.id, attempt.owner, { ...attempt, status: 'review' });
        }
      }
      for (const agreement of store.list('agreement')) {
        if (['setup_pending', 'cancel_pending'].includes(agreement.status)) await setupNative(agreement);
        else if (agreement.status === 'active' && agreement.engine === 'merchant') await chargeAgreement(agreement.id);
        else if (agreement.engine === 'braintree' && ['active', 'past_due'].includes(agreement.status)) {
          try { await webhook({ subscription: await gateway.subscription.find(agreement.nativeId) }); }
          catch { /* Signed webhooks and the next poll can reconcile a transient read failure. */ }
        }
        else if (agreement.status === 'charging') {
          const lock = store.lock(`agreement:${agreement.id}`);
          if (lock) {
            store.update('agreement', agreement.id, agreement.owner, value => ({ ...value, status: 'review', lastError: 'Billing was interrupted. Check Braintree before retrying; automatic charges are paused.' }));
            store.unlock(`agreement:${agreement.id}`, lock);
          }
        }
      }
    } finally { running = false; }
  }

  function summary(owner) {
    return {
      methods: store.list('method', owner).filter(value => !value.removed).map(({ id, label, type }) => ({ id, label, type })),
      agreements: store.list('agreement', owner).map(({ id, billing, status, engine, nextDue, balancePence, accruedPence, lastError, methodId }) => ({ id, name: billing.name, type: billing.type, amount: pounds(billing.amountPence), frequency: billing.frequency, status, engine, nextDue, balance: pounds(balancePence), accrued: pounds(accruedPence), lastError, methodId })),
      payments: [...store.list('payment', owner), ...store.list('attempt', owner).filter(value => ['processing', 'review', 'declined'].includes(value.status))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(({ id, amount, description, status, createdAt }) => ({ id, amount, description, status, createdAt })),
    };
  }

  async function savedNonce(owner, id) {
    const method = store.get('method', id, owner);
    if (!method || method.removed) fail('Saved payment method not found.', 404);
    if (method.type === 'PayPalAccount') return { savedMethodId: id, type: method.type };
    const result = await gateway.paymentMethodNonce.create(method.token);
    return { nonce: result.paymentMethodNonce.nonce, bin: result.paymentMethodNonce.details?.bin, type: method.type };
  }

  async function removeMethod(owner, id) {
    const method = store.get('method', id, owner);
    if (!method || method.removed) fail('Saved payment method not found.', 404);
    if (store.list('agreement', owner).some(value => value.methodId === id && !['cancelled', 'completed'].includes(value.status))) fail('Cancel or change the plans using this payment method first.', 409);
    await gateway.paymentMethod.delete(method.token);
    store.put('method', id, owner, { ...method, removed: true });
  }

  async function changeMethod(owner, id, methodId) {
    const agreement = store.get('agreement', id, owner);
    const method = store.get('method', methodId, owner);
    if (!agreement || !method || method.removed) fail('Plan or saved payment method not found.', 404);
    if (['cancelled', 'completed', 'cancel_pending'].includes(agreement.status)) fail('This plan has ended.', 409);
    const lock = store.lock(`agreement:${id}`);
    if (!lock) fail('A payment is processing. Try again shortly.', 409);
    try {
      if (agreement.engine === 'braintree') {
        const result = await gateway.subscription.update(agreement.nativeId, { paymentMethodToken: method.token });
        if (!result.success) fail(result.message || 'Could not update the subscription.', 502);
      }
      store.update('agreement', id, owner, value => ({ ...value, methodId }));
    } finally { store.unlock(`agreement:${id}`, lock); }
  }

  async function retry(owner, id) {
    const agreement = store.get('agreement', id, owner);
    if (!agreement) fail('Plan not found.', 404);
    if (agreement.status !== 'past_due') fail('Only a confirmed declined payment can be retried.', 409);
    if (agreement.engine === 'merchant') return chargeAgreement(id, { retry: true });
    const lock = store.lock(`agreement:${id}`);
    if (!lock) fail('A billing operation is already processing.', 409);
    try {
      if (store.get('agreement', id, owner).status !== 'past_due') return;
      store.update('agreement', id, owner, value => ({ ...value, status: 'charging' }));
      const result = await gateway.subscription.retryCharge(agreement.nativeId, undefined, true);
      if (!result.success) { store.update('agreement', id, owner, value => ({ ...value, status: 'past_due' })); fail(result.message || 'Payment was declined.'); }
      const transaction = result.transaction;
      store.put('payment', transaction.id, owner, { id: transaction.id, owner, agreementId: id, amount: transaction.amount, description: agreement.billing.name, status: transaction.status, createdAt: now().toISOString() });
      store.update('agreement', id, owner, value => ({ ...value, status: 'active', lastError: undefined }));
    } catch (error) {
      if (store.get('agreement', id, owner).status === 'charging') store.update('agreement', id, owner, value => ({ ...value, status: 'review', lastError: 'Check Braintree before retrying this payment.' }));
      throw error;
    } finally { store.unlock(`agreement:${id}`, lock); }
  }

  return { merchantAccount, checkout, chargeAgreement, recordUsage, cancel, webhook, tick, summary, savedNonce, removeMethod, changeMethod, retry };
}

module.exports = { createBillingService };
