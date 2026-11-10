const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BRAINTREE_PRIVATE_KEY ||= 'test-private-key';
process.env.BILLING_QUOTE_SECRET ||= 'test-quote-secret';

const { buildBillingPlan } = require('../services/billing-service');
const {
  createBillingQuote,
  createPurchaseQuote,
  resolveBillingQuote,
  resolvePurchaseQuote,
} = require('../services/billing-quote-service');

function testPlan() {
  return buildBillingPlan({
    type: 'subscription',
    description: 'Bound subscription',
    amount: '35.00',
    frequency: 'monthly',
  }, 'GBP');
}

test('binds approved billing terms and first charge date in a signed quote', () => {
  const quote = createBillingQuote(
    testPlan(),
    'catalog',
    new Date('2026-01-31T12:00:00.000Z'),
  );
  const resolved = resolveBillingQuote(
    quote.token,
    'catalog',
    new Date('2026-01-31T12:05:00.000Z'),
  );

  assert.equal(resolved.planDetails.amount, '35.00');
  assert.equal(resolved.planDetails.frequency, 'MONTH');
  assert.equal(resolved.planDetails.firstBillingDate, '2026-02-28');
});

test('rejects tampered, cross-endpoint, and expired billing quotes', () => {
  const issuedAt = new Date('2026-01-01T00:00:00.000Z');
  const quote = createBillingQuote(testPlan(), 'custom', issuedAt);
  const finalCharacter = quote.token.endsWith('A') ? 'B' : 'A';
  const tampered = `${quote.token.slice(0, -1)}${finalCharacter}`;

  assert.throws(
    () => resolveBillingQuote(tampered, 'custom', issuedAt),
    /invalid/,
  );
  assert.throws(
    () => resolveBillingQuote(quote.token, 'catalog', issuedAt),
    /expired or is invalid/,
  );
  assert.throws(
    () => resolveBillingQuote(
      quote.token,
      'custom',
      new Date('2026-01-01T02:00:00.000Z'),
    ),
    /expired or is invalid/,
  );
});

test('binds a one-time purchase selection and amount to its checkout quote', () => {
  const now = new Date('2026-05-01T10:00:00.000Z');
  const quote = createPurchaseQuote({
    productId: 'iphone-16',
    storage: '256GB',
    colour: 'Black',
    description: 'Apple iPhone 16 (256GB, Black)',
    amount: '929.00',
  }, now);
  const purchase = resolvePurchaseQuote(
    quote.token,
    new Date('2026-05-01T10:05:00.000Z'),
  );

  assert.equal(purchase.amount, '929.00');
  assert.equal(purchase.storage, '256GB');
  assert.throws(
    () => resolveBillingQuote(quote.token, 'catalog', now),
    /expired or is invalid/,
  );
});
