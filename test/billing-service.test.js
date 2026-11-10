const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  buildBillingPlan,
  getInitialCharge,
} = require('../services/billing-service');
const catalogService = require('../services/catalog-service');
const transactionStore = require('../services/transaction-store');

test('builds a validated fixed subscription preview', () => {
  const plan = buildBillingPlan({
    type: 'subscription',
    description: 'Unlimited plan',
    amount: '35',
    frequency: 'monthly',
  }, 'GBP');

  assert.deepEqual(plan, {
    type: 'subscription',
    description: 'Unlimited plan',
    planDetails: {
      description: 'Unlimited plan',
      currencyIsoCode: 'GBP',
      amount: '35.00',
      frequency: 'MONTH',
    },
  });
});

test('charges only the setup fee initially for a hybrid plan', () => {
  const plan = buildBillingPlan({
    type: 'hybrid',
    description: 'Phone and plan',
    oneTimeAmount: '199',
    recurringAmount: '60',
    frequency: 'monthly',
  }, 'GBP');

  assert.deepEqual(getInitialCharge(plan), {
    amount: '199.00',
    transactionSource: 'recurring_first',
    message: 'One-time setup fee processed in GBP.',
  });
});

test('rejects unsupported billing types and invalid amounts', () => {
  assert.throws(
    () => buildBillingPlan({ type: 'unknown', description: 'Invalid' }, 'GBP'),
    ValidationError,
  );

  assert.throws(
    () => buildBillingPlan({
      type: 'subscription',
      description: 'Invalid amount',
      amount: '0',
      frequency: 'monthly',
    }, 'GBP'),
    /amount must be a positive number/,
  );
});

test('validates installment boundaries', () => {
  assert.throws(
    () => buildBillingPlan({
      type: 'installments',
      description: 'Phone',
      amount: '40',
      frequency: 'monthly',
      installments: '1',
    }, 'GBP'),
    /between 2 and 36/,
  );
});

test('resolves storefront prices from the server-side catalog', () => {
  const plan = catalogService.billingProduct('unlimited-data');
  assert.equal(plan.amount, '35.00');

  const device = catalogService.oneTimePurchase({
    productId: 'iphone-16',
    storage: '256GB',
    colour: 'Black',
  });
  assert.equal(device.amount, '929.00');
  assert.equal(device.description, 'Apple iPhone 16 (256GB, Black)');
});

test('rejects unknown catalog products and options', () => {
  assert.throws(
    () => catalogService.billingProduct('not-a-product'),
    /Unknown billing product/,
  );

  assert.throws(
    () => catalogService.oneTimePurchase({
      productId: 'iphone-16',
      storage: '4TB',
      colour: 'Black',
    }),
    /storage option is not available/,
  );
});

test('stores only server-recorded transaction summaries for the success page', () => {
  transactionStore.add({
    transactionId: 'test-transaction-id',
    amount: '35.00',
    currency: 'GBP',
  });

  assert.equal(transactionStore.get('test-transaction-id').amount, '35.00');
  assert.equal(transactionStore.get('invented-transaction-id'), null);
});
