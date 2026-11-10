const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.BRAINTREE_MERCHANT_ID ||= 'test-merchant';
process.env.BRAINTREE_PUBLIC_KEY ||= 'test-public-key';
process.env.BRAINTREE_PRIVATE_KEY ||= 'test-private-key';

const {
  BillingAgreementStore,
} = require('../services/billing-agreement-store');
const {
  createBillingAgreementService,
} = require('../services/billing-agreement-service');
const {
  buildBillingPlan,
  getInitialCharge,
} = require('../services/billing-service');

const STARTED_AT = new Date('2026-01-15T12:00:00.000Z');

async function createFixture(t, transactionHandler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'braintree-agreement-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const calls = [];
  const deletedCustomers = [];
  const gateway = {
    async createTransaction(input) {
      calls.push(structuredClone(input));

      if (transactionHandler) {
        return transactionHandler(input, calls.length);
      }

      return {
        success: true,
        transaction: {
          id: `transaction-${calls.length}`,
          amount: input.amount,
        },
      };
    },
    async deleteCustomer(customerId) {
      deletedCustomers.push(customerId);
      return { success: true };
    },
  };
  const filePath = path.join(directory, 'agreements.json');
  const store = new BillingAgreementStore(filePath);
  const service = createBillingAgreementService({ store, gateway });

  return {
    calls,
    deletedCustomers,
    directory,
    filePath,
    gateway,
    service,
    store,
  };
}

function billingPlan(type) {
  const inputs = {
    subscription: {
      type,
      description: 'Fixed subscription',
      amount: '35',
      frequency: 'monthly',
    },
    recurring: {
      type,
      description: 'Variable recurring bill',
      amount: '25',
      frequency: 'monthly',
    },
    installments: {
      type,
      description: 'Three installments',
      amount: '40',
      frequency: 'monthly',
      installments: '3',
    },
    hybrid: {
      type,
      description: 'Device and plan',
      oneTimeAmount: '199',
      recurringAmount: '60',
      frequency: 'monthly',
    },
    unscheduled: {
      type,
      description: 'Automatic reload',
      reloadAmount: '20',
      reloadThreshold: '5',
    },
  };

  return buildBillingPlan(inputs[type], 'GBP');
}

async function createActivatedAgreement(service, type, suffix = type) {
  const plan = billingPlan(type);
  const initialCharge = getInitialCharge(plan);
  const pending = await service.createPending({
    billingPlan: plan,
    vault: {
      customerId: `customer-${suffix}`,
      paymentMethodToken: `vault-token-${suffix}`,
      email: `${suffix}@example.test`,
    },
    initialCharge,
    now: STARTED_AT,
  });
  await service.activateInitial(pending.id, {
    id: `initial-transaction-${suffix}`,
    amount: initialCharge.amount,
  }, STARTED_AT);

  return pending.id;
}

test('persists agreements while redacting the vaulted token from public responses', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'subscription');

  const publicAgreement = await fixture.service.get(id);
  assert.equal(publicAgreement.hasPaymentMethod, true);
  assert.equal(publicAgreement.paymentMethodToken, undefined);
  assert.equal(publicAgreement.chargeInProgress, false);

  const reloadedStore = new BillingAgreementStore(fixture.filePath);
  const persisted = await reloadedStore.require(id);
  assert.equal(persisted.paymentMethodToken, 'vault-token-subscription');
  assert.equal(persisted.status, 'active');

  if (process.platform !== 'win32') {
    const mode = (await fs.stat(fixture.filePath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('uses the correct Braintree transaction source for initial and later charges', async t => {
  const expected = {
    subscription: ['recurring_first', 'recurring'],
    recurring: ['recurring_first', 'recurring'],
    installments: ['installment_first', 'installment'],
    hybrid: ['recurring_first', 'recurring'],
    unscheduled: ['unscheduled', 'unscheduled'],
  };

  const fixture = await createFixture(t);

  for (const [type, [initialSource, laterSource]] of Object.entries(expected)) {
    const plan = billingPlan(type);
    assert.equal(getInitialCharge(plan).transactionSource, initialSource);

    const id = await createActivatedAgreement(fixture.service, type, `source-${type}`);
    if (type === 'recurring') {
      await fixture.service.updateVariableAmount(id, '27.50');
    }

    const result = await fixture.service.charge(id, {
      force: true,
      now: new Date('2026-02-15T12:00:00.000Z'),
    });
    assert.equal(result.success, true);
    assert.equal(fixture.calls.at(-1).transactionSource, laterSource);
    assert.equal(fixture.calls.at(-1).paymentMethodToken, `vault-token-source-${type}`);
  }
});

test('completes an installment agreement after exactly the configured number of payments', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'installments');

  await fixture.service.charge(id, {
    force: true,
    now: new Date('2026-02-15T12:00:00.000Z'),
  });
  const finalCharge = await fixture.service.charge(id, {
    force: true,
    now: new Date('2026-03-15T12:00:00.000Z'),
  });

  assert.equal(finalCharge.agreement.status, 'completed');
  assert.equal(finalCharge.agreement.completedCycles, 3);
  assert.equal(finalCharge.agreement.nextChargeAt, null);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls.map(call => call.transactionSource), [
    'installment',
    'installment',
  ]);

  await assert.rejects(
    fixture.service.charge(id, { force: true }),
    /Cannot charge an agreement with status completed/,
  );
});

test('distinguishes a definitive decline from an ambiguous gateway failure', async t => {
  const fixture = await createFixture(t, async (_input, callNumber) => {
    if (callNumber === 1) {
      return { success: false, message: 'Processor declined the transaction.' };
    }
    throw new Error('Gateway connection ended before a response was received.');
  });
  const declinedId = await createActivatedAgreement(
    fixture.service,
    'subscription',
    'declined',
  );
  const ambiguousId = await createActivatedAgreement(
    fixture.service,
    'subscription',
    'ambiguous',
  );

  const declined = await fixture.service.charge(declinedId, { force: true });
  assert.equal(declined.success, false);
  assert.equal(declined.agreement.status, 'past_due');
  assert.equal(declined.agreement.chargeInProgress, false);

  await assert.rejects(
    fixture.service.charge(ambiguousId, { force: true }),
    /Gateway connection ended/,
  );
  const ambiguous = await fixture.service.get(ambiguousId);
  assert.equal(ambiguous.status, 'review_required');
  assert.equal(ambiguous.chargeInProgress, true);
  assert.match(ambiguous.inFlightOrderId, new RegExp(`^${ambiguousId}-`));
});

test('allows only one concurrent charge attempt for an agreement', async t => {
  let finishTransaction;
  const fixture = await createFixture(t, input => new Promise(resolve => {
    finishTransaction = () => resolve({
      success: true,
      transaction: { id: 'concurrent-transaction', amount: input.amount },
    });
  }));
  const id = await createActivatedAgreement(fixture.service, 'subscription');

  const firstCharge = fixture.service.charge(id, { force: true });
  while (!finishTransaction) {
    await new Promise(resolve => setImmediate(resolve));
  }

  await assert.rejects(
    fixture.service.charge(id, { force: true }),
    /already in progress/,
  );
  assert.equal(fixture.calls.length, 1);

  finishTransaction();
  const result = await firstCharge;
  assert.equal(result.success, true);
  assert.equal(result.transactionId, 'concurrent-transaction');
});

test('the due runner charges an active agreement only when its persisted date is reached', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'subscription');
  const agreement = await fixture.service.get(id);
  const dueAt = new Date(agreement.nextChargeAt).getTime();

  let results = await fixture.service.runDue({
    now: new Date(dueAt - 1),
    limit: 20,
  });
  assert.deepEqual(results, []);
  assert.equal(fixture.calls.length, 0);

  results = await fixture.service.runDue({
    now: new Date(dueAt),
    limit: 20,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, id);
  assert.equal(results[0].success, true);
  assert.equal(fixture.calls.length, 1);
});

test('requires a new amount before each variable recurring charge', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'recurring');

  let agreement = await fixture.service.get(id);
  assert.equal(agreement.status, 'awaiting_amount');
  await assert.rejects(
    fixture.service.charge(id, { force: true }),
    /status awaiting_amount/,
  );

  agreement = await fixture.service.updateVariableAmount(id, '42.75');
  assert.equal(agreement.status, 'active');
  const result = await fixture.service.charge(id, { force: true });
  assert.equal(result.agreement.status, 'awaiting_amount');
  assert.equal(fixture.calls[0].amount, '42.75');
});

test('rejects manual amount overrides for fixed billing agreements', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'subscription');

  await assert.rejects(
    fixture.service.charge(id, { force: true, amount: '0.01' }),
    /fixed charge amount/,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.service.get(id)).chargeInProgress, false);
});

test('reloads an unscheduled balance only after usage crosses its threshold', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'unscheduled');

  const aboveThreshold = await fixture.service.recordUsage(id, '10.00');
  assert.equal(aboveThreshold.reloaded, false);
  assert.equal(aboveThreshold.agreement.balance, '10.00');
  assert.equal(fixture.calls.length, 0);

  const belowThreshold = await fixture.service.recordUsage(id, '6.00');
  assert.equal(belowThreshold.reloaded, true);
  assert.equal(belowThreshold.agreement.balance, '24.00');
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].transactionSource, 'unscheduled');
});

test('pauses, resumes, and cancels while revoking the vaulted customer', async t => {
  const fixture = await createFixture(t);
  const id = await createActivatedAgreement(fixture.service, 'subscription');

  let agreement = await fixture.service.pause(id);
  assert.equal(agreement.status, 'paused');
  assert.equal(agreement.nextChargeAt, null);

  agreement = await fixture.service.resume(id, new Date('2026-04-01T00:00:00.000Z'));
  assert.equal(agreement.status, 'active');
  assert.ok(agreement.nextChargeAt);

  agreement = await fixture.service.cancel(id);
  assert.equal(agreement.status, 'cancelled');
  assert.equal(agreement.paymentMethodToken, null);
  assert.deepEqual(fixture.deletedCustomers, ['customer-subscription']);

  const publicAgreement = await fixture.service.get(id);
  assert.equal(publicAgreement.hasPaymentMethod, false);
});

test('marks an interrupted persisted charge for operator review after restart', async t => {
  const fixture = await createFixture(t);
  const plan = billingPlan('subscription');
  const pending = await fixture.service.createPending({
    billingPlan: plan,
    vault: {
      customerId: 'interrupted-customer',
      paymentMethodToken: 'interrupted-token',
    },
    initialCharge: getInitialCharge(plan),
    now: STARTED_AT,
  });

  const restartedStore = new BillingAgreementStore(fixture.filePath);
  assert.equal(await restartedStore.markInterruptedChargesForReview(), true);
  const agreement = await restartedStore.require(pending.id);
  assert.equal(agreement.status, 'review_required');
  assert.equal(agreement.nextChargeAt, null);
  assert.equal(agreement.inFlight.kind, 'initial');
  assert.match(agreement.lastError, /Verify the order ID/);
});

test('resolves an ambiguous charge only after Braintree verifies the exact transaction', async t => {
  const fixture = await createFixture(t, async () => {
    throw new Error('Connection ended after submission.');
  });
  const id = await createActivatedAgreement(fixture.service, 'subscription', 'review');

  await assert.rejects(
    fixture.service.charge(id, { force: true }),
    /Connection ended/,
  );
  const review = await fixture.service.get(id);

  fixture.gateway.findTransaction = async transactionId => ({
    id: transactionId,
    orderId: review.inFlightOrderId,
    amount: '0.01',
    currencyIsoCode: 'GBP',
    status: 'submitted_for_settlement',
    type: 'sale',
    customer: { id: 'customer-review' },
  });
  await assert.rejects(
    fixture.service.resolveReview(id, {
      outcome: 'charged',
      transactionId: 'verified-transaction',
    }),
    /does not match.*amount/,
  );
  assert.equal((await fixture.service.get(id)).status, 'review_required');

  fixture.gateway.findTransaction = async transactionId => ({
    id: transactionId,
    orderId: review.inFlightOrderId,
    amount: '35.00',
    currencyIsoCode: 'GBP',
    status: 'submitted_for_settlement',
    type: 'sale',
    customer: { id: 'customer-review' },
  });
  const resolved = await fixture.service.resolveReview(id, {
    outcome: 'charged',
    transactionId: 'verified-transaction',
    now: new Date('2026-02-15T12:00:00.000Z'),
  });

  assert.equal(resolved.status, 'active');
  assert.equal(resolved.lastTransactionId, 'verified-transaction');
  assert.equal(resolved.chargeInProgress, false);
});
