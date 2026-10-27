'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMerchantAccountCatalog } = require('../lib/catalog/build-catalog');
const { resolveRoute } = require('../lib/routing/resolve-route');

const DISCOVERED_ACCOUNTS = Object.freeze([
  Object.freeze({
    merchantAccountId: 'paypal',
    currency: 'EUR',
    status: 'active',
    isDefault: false,
  }),
  Object.freeze({
    merchantAccountId: 'paypal2',
    currency: 'GBP',
    status: 'active',
    isDefault: true,
  }),
  Object.freeze({
    merchantAccountId: 'vmUSD',
    currency: 'USD',
    status: 'active',
    isDefault: false,
  }),
  Object.freeze({
    merchantAccountId: 'vmUSD2',
    currency: 'USD',
    status: 'active',
    isDefault: false,
  }),
]);

const HUMAN_POLICY = Object.freeze({
  merchantId: 'resolver-test-merchant',
  accounts: Object.freeze({
    paypal: Object.freeze({
      label: 'EU Store – EUR',
      paymentTypes: Object.freeze(['one_time', 'recurring']),
    }),
    paypal2: Object.freeze({
      label: 'UK Store – GBP',
      paymentTypes: Object.freeze(['one_time', 'recurring']),
    }),
    vmUSD: Object.freeze({
      label: 'US Store – One-time',
      paymentTypes: Object.freeze(['one_time']),
    }),
    vmUSD2: Object.freeze({
      label: 'US Store – Subscriptions',
      paymentTypes: Object.freeze(['recurring']),
    }),
  }),
});

const POLICY_CATALOG = buildMerchantAccountCatalog({
  merchantId: 'resolver-test-merchant',
  discoveredAccounts: DISCOVERED_ACCOUNTS,
  policy: HUMAN_POLICY,
}).accounts;

const AUTO_CATALOG = buildMerchantAccountCatalog({
  merchantId: 'resolver-test-merchant',
  discoveredAccounts: DISCOVERED_ACCOUNTS,
}).accounts;

function mutablePolicyCatalog() {
  return structuredClone(POLICY_CATALOG);
}

function assertMatchedPolicyRoute(intent, expectedAccountId) {
  const decision = resolveRoute(intent, POLICY_CATALOG);

  assert.equal(decision.matched, true);
  assert.deepEqual(decision.intent, intent);
  assert.equal(decision.account.merchantAccountId, expectedAccountId);
  assert.equal(decision.account.key, expectedAccountId);
  assert.equal(decision.account.paymentTypeSources[intent.paymentType], 'policy');
  assert.equal(decision.reason, 'Matched by merchant policy');
  assert.equal(decision.trace.length, POLICY_CATALOG.length);
  assert.equal(decision.trace.filter((entry) => entry.result === 'matched').length, 1);
  assert.deepEqual(
    decision.trace.find((entry) => entry.result === 'matched'),
    {
      account: expectedAccountId,
      result: 'matched',
      why: 'Matched by merchant policy',
    }
  );
}

test('routes GBP one-time payments to the policy-selected UK Store account', () => {
  assertMatchedPolicyRoute(
    { currency: 'GBP', paymentType: 'one_time' },
    'paypal2'
  );
});

test('routes EUR one-time payments to the policy-selected EU Store account', () => {
  assertMatchedPolicyRoute(
    { currency: 'EUR', paymentType: 'one_time' },
    'paypal'
  );
});

test('routes USD one-time payments to processor variant vmUSD by merchant policy', () => {
  assertMatchedPolicyRoute(
    { currency: 'USD', paymentType: 'one_time' },
    'vmUSD'
  );

  const decision = resolveRoute(
    { currency: 'USD', paymentType: 'one_time' },
    POLICY_CATALOG
  );
  const otherVariant = decision.trace.find((entry) => entry.account === 'vmUSD2');
  assert.match(otherVariant.why, /assigned for recurring, not one-time/);
});

test('routes USD recurring payments to processor variant vmUSD2 by merchant policy', () => {
  assertMatchedPolicyRoute(
    { currency: 'USD', paymentType: 'recurring' },
    'vmUSD2'
  );

  const decision = resolveRoute(
    { currency: 'USD', paymentType: 'recurring' },
    POLICY_CATALOG
  );
  const otherVariant = decision.trace.find((entry) => entry.account === 'vmUSD');
  assert.match(otherVariant.why, /assigned for one-time, not recurring/);
});

test('reports automatic assignment wording from a catalog built without an overlay', () => {
  const decision = resolveRoute(
    { currency: 'USD', paymentType: 'one_time' },
    AUTO_CATALOG
  );

  assert.equal(decision.matched, true);
  assert.equal(decision.account.merchantAccountId, 'vmUSD');
  assert.equal(decision.account.paymentTypeSources.one_time, 'auto');
  assert.equal(
    decision.reason,
    'Matched automatically (first active USD account by merchant account ID)'
  );
  assert.deepEqual(
    decision.trace.find((entry) => entry.result === 'matched'),
    {
      account: 'vmUSD',
      result: 'matched',
      why: 'Matched automatically (first active USD account by merchant account ID)',
    }
  );
  assert.deepEqual(
    decision.trace.find((entry) => entry.account === 'vmUSD2'),
    {
      account: 'vmUSD2',
      result: 'skipped',
      why: 'available but not assigned',
    }
  );
});

test('normalizes currency and payment type before matching', () => {
  const decision = resolveRoute(
    { currency: ' usd ', paymentType: ' One-Time ' },
    POLICY_CATALOG
  );

  assert.equal(decision.matched, true);
  assert.deepEqual(decision.intent, {
    currency: 'USD',
    paymentType: 'one_time',
  });
  assert.equal(decision.account.merchantAccountId, 'vmUSD');
});

test('returns an explicit no-route decision for unsupported JPY without a default fallback', () => {
  const decision = resolveRoute(
    { currency: 'JPY', paymentType: 'one_time' },
    POLICY_CATALOG
  );

  assert.equal(decision.matched, false);
  assert.deepEqual(decision.intent, { currency: 'JPY', paymentType: 'one_time' });
  assert.equal(decision.account, null);
  assert.match(
    decision.reason,
    /No active merchant account is configured for JPY one-time payments/
  );
  assert.equal(decision.trace.length, POLICY_CATALOG.length);
  assert.ok(decision.trace.every((entry) => entry.result === 'skipped'));
  assert.ok(decision.trace.every((entry) => entry.why.includes('\u2260 JPY')));
});

test('returns a structured validation failure for an invalid intent', () => {
  const decision = resolveRoute(
    { currency: 'US', paymentType: 'installment' },
    POLICY_CATALOG
  );

  assert.equal(decision.matched, false);
  assert.deepEqual(decision.intent, { currency: 'US', paymentType: 'installment' });
  assert.equal(decision.account, null);
  assert.match(decision.reason, /Invalid routing intent/);
  assert.match(decision.reason, /currency must be a three-letter currency code/);
  assert.match(decision.reason, /paymentType must be "one_time" or "recurring"/);
  assert.equal(decision.trace.length, POLICY_CATALOG.length);
  assert.ok(decision.trace.every((entry) => entry.result === 'skipped'));
  assert.ok(decision.trace.every((entry) => entry.why === decision.reason));
});

test('does not match an inactive route in an injected catalog', () => {
  const catalog = mutablePolicyCatalog();
  catalog.find((account) => account.merchantAccountId === 'vmUSD').status = 'suspended';

  const decision = resolveRoute(
    { currency: 'USD', paymentType: 'one_time' },
    catalog
  );

  assert.equal(decision.matched, false);
  assert.equal(decision.account, null);
  assert.match(decision.reason, /No active merchant account/);
  assert.deepEqual(
    decision.trace.find((entry) => entry.account === 'vmUSD'),
    {
      account: 'vmUSD',
      result: 'skipped',
      why: 'account is not active (status: suspended)',
    }
  );
});

test('ignores a client-supplied merchant account ID', () => {
  const decision = resolveRoute(
    {
      currency: 'EUR',
      paymentType: 'one_time',
      merchantAccountId: 'vmUSD2',
    },
    POLICY_CATALOG
  );

  assert.equal(decision.matched, true);
  assert.equal(decision.account.merchantAccountId, 'paypal');
  assert.deepEqual(decision.intent, {
    currency: 'EUR',
    paymentType: 'one_time',
  });
  assert.equal(Object.hasOwn(decision.intent, 'merchantAccountId'), false);
});

test('returns an account copy and does not mutate an injected catalog', () => {
  const catalog = mutablePolicyCatalog();
  const before = structuredClone(catalog);
  const decision = resolveRoute(
    { currency: 'GBP', paymentType: 'recurring' },
    catalog
  );
  const sourceAccount = catalog.find(
    (account) => account.merchantAccountId === 'paypal2'
  );

  assert.deepEqual(catalog, before);
  assert.notStrictEqual(decision.account, sourceAccount);
  assert.notStrictEqual(decision.account.paymentTypes, sourceAccount.paymentTypes);
  assert.notStrictEqual(
    decision.account.paymentTypeSources,
    sourceAccount.paymentTypeSources
  );
  assert.notStrictEqual(decision.account.routingReasons, sourceAccount.routingReasons);
});

test('rejects a missing or non-array injected catalog', () => {
  assert.throws(
    () => resolveRoute({ currency: 'GBP', paymentType: 'one_time' }),
    /Routing catalog must be an array/
  );
  assert.throws(
    () => resolveRoute({ currency: 'GBP', paymentType: 'one_time' }, {}),
    /Routing catalog must be an array/
  );
});
