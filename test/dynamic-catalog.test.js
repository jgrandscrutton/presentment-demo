'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMerchantAccountCatalog } = require('../lib/catalog/build-catalog');
const {
  CatalogUnavailableError,
  MerchantAccountNotFoundError,
} = require('../lib/catalog/errors');
const { createCatalogService } = require('../lib/catalog/service');

function discovered(merchantAccountId, currency, options = {}) {
  return {
    merchantAccountId,
    currency,
    status: options.status || 'active',
    isDefault: options.isDefault === true,
  };
}

function routeAccount(catalog, currency, paymentType) {
  return catalog.accounts.find(
    (account) =>
      account.currency === currency && account.paymentTypes.includes(paymentType)
  );
}

const humanAccounts = Object.freeze([
  discovered('paypal', 'EUR'),
  discovered('paypal2', 'GBP', { isDefault: true }),
  discovered('vmUSD', 'USD'),
  discovered('vmUSD2', 'USD'),
]);

const humanPolicy = Object.freeze({
  merchantId: 'fixture-merchant',
  accounts: {
    paypal2: {
      label: 'UK Store – GBP',
      paymentTypes: ['one_time', 'recurring'],
    },
    paypal: {
      label: 'EU Store – EUR',
      paymentTypes: ['one_time', 'recurring'],
    },
    vmUSD: {
      label: 'US Store – One-time',
      paymentTypes: ['one_time'],
    },
    vmUSD2: {
      label: 'US Store – Subscriptions',
      paymentTypes: ['recurring'],
    },
  },
});

test('the four-account fixture plus policy preserves every Stage 1 route', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'fixture-merchant',
    discoveredAccounts: humanAccounts,
    policy: humanPolicy,
  });

  assert.equal(routeAccount(catalog, 'EUR', 'one_time').merchantAccountId, 'paypal');
  assert.equal(routeAccount(catalog, 'GBP', 'one_time').merchantAccountId, 'paypal2');
  assert.equal(routeAccount(catalog, 'USD', 'one_time').merchantAccountId, 'vmUSD');
  assert.equal(routeAccount(catalog, 'USD', 'recurring').merchantAccountId, 'vmUSD2');
  assert.equal(routeAccount(catalog, 'JPY', 'one_time'), undefined);
  assert.ok(catalog.accounts.every((account) => account.roleSource === 'policy'));
  assert.ok(
    catalog.accounts.every((account) =>
      Object.values(account.routingReasons).every(
        (reason) => reason === 'Matched by merchant policy'
      )
    )
  );
});

test('without an overlay deterministic auto-assignment uses one USD account for both roles', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'fixture-merchant',
    discoveredAccounts: humanAccounts,
  });
  const assigned = catalog.accounts.find(
    (account) => account.merchantAccountId === 'vmUSD'
  );
  const available = catalog.accounts.find(
    (account) => account.merchantAccountId === 'vmUSD2'
  );

  assert.deepEqual(assigned.paymentTypes, ['one_time', 'recurring']);
  assert.equal(assigned.roleSource, 'auto');
  assert.equal(assigned.assignmentState, 'assigned');
  assert.deepEqual(available.paymentTypes, []);
  assert.equal(available.roleSource, null);
  assert.equal(available.assignmentState, 'available_not_assigned');
});

test('single-account gateways auto-assign both payment types and freeze the result', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'single-merchant',
    discoveredAccounts: [discovered('only-account', 'CAD', { isDefault: true })],
  });

  assert.deepEqual(catalog.accounts[0].paymentTypes, ['one_time', 'recurring']);
  assert.equal(catalog.accounts[0].roleSource, 'auto');
  assert.match(catalog.accounts[0].routingReasons.one_time, /only active CAD account/);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.accounts));
  assert.ok(Object.isFrozen(catalog.accounts[0].paymentTypeSources));
});

test('an inactive only account is displayed but receives no route', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'inactive-merchant',
    discoveredAccounts: [
      discovered('active-default', 'GBP', { isDefault: true }),
      discovered('inactive-only', 'JPY', { status: 'suspended' }),
    ],
  });
  const inactive = catalog.accounts.find(
    (account) => account.merchantAccountId === 'inactive-only'
  );

  assert.deepEqual(inactive.paymentTypes, []);
  assert.equal(inactive.assignmentState, 'inactive');
  assert.equal(routeAccount(catalog, 'JPY', 'one_time'), undefined);
});

test('missing policy accounts warn and are ignored while valid entries still apply', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'fixture-merchant',
    discoveredAccounts: humanAccounts,
    policy: {
      merchantId: 'fixture-merchant',
      accounts: {
        paypal: { label: 'Configured EUR', paymentTypes: ['one_time'] },
        staleAccount: { label: 'Stale', paymentTypes: ['recurring'] },
      },
    },
  });

  assert.equal(routeAccount(catalog, 'EUR', 'one_time').label, 'Configured EUR');
  assert.ok(catalog.warnings.some((item) => item.code === 'POLICY_ACCOUNT_NOT_FOUND'));
});

test('merchant ID mismatch ignores the whole policy with a warning', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'fixture-merchant',
    discoveredAccounts: humanAccounts,
    policy: {
      merchantId: 'another-merchant',
      accounts: humanPolicy.accounts,
    },
  });

  assert.equal(catalog.policyStatus, 'ignored');
  assert.equal(routeAccount(catalog, 'USD', 'one_time').merchantAccountId, 'vmUSD');
  assert.equal(routeAccount(catalog, 'USD', 'recurring').merchantAccountId, 'vmUSD');
  assert.ok(
    catalog.warnings.some((item) => item.code === 'POLICY_MERCHANT_ID_MISMATCH')
  );
});

test('a duplicate active route rejects the whole overlay and falls back to auto-assignment', () => {
  const catalog = buildMerchantAccountCatalog({
    merchantId: 'fixture-merchant',
    discoveredAccounts: humanAccounts,
    policy: {
      merchantId: 'fixture-merchant',
      accounts: {
        vmUSD: { label: 'First', paymentTypes: ['one_time'] },
        vmUSD2: { label: 'Second', paymentTypes: ['one_time'] },
      },
    },
  });

  assert.equal(catalog.policyStatus, 'rejected');
  assert.equal(routeAccount(catalog, 'USD', 'one_time').merchantAccountId, 'vmUSD');
  assert.equal(routeAccount(catalog, 'USD', 'recurring').merchantAccountId, 'vmUSD');
  assert.ok(catalog.accounts.every((account) => account.label !== 'First'));
  assert.ok(catalog.warnings.some((item) => item.code === 'POLICY_DUPLICATE_ROUTE'));
});

test('catalog validation rejects discovery with no default or multiple defaults', () => {
  assert.throws(
    () => buildMerchantAccountCatalog({
      merchantId: 'fixture-merchant',
      discoveredAccounts: [discovered('no-default', 'GBP')],
    }),
    /exactly one default account/
  );
  assert.throws(
    () => buildMerchantAccountCatalog({
      merchantId: 'fixture-merchant',
      discoveredAccounts: [
        discovered('default-a', 'GBP', { isDefault: true }),
        discovered('default-b', 'EUR', { isDefault: true }),
      ],
    }),
    /exactly one default account/
  );
});

test('catalog construction rejects an inactive default account', () => {
  assert.throws(
    () => buildMerchantAccountCatalog({
      merchantId: 'inactive-default-merchant',
      discoveredAccounts: [
        discovered('inactive-default', 'GBP', {
          isDefault: true,
          status: 'suspended',
        }),
        discovered('active-secondary', 'EUR'),
      ],
    }),
    /default account inactive-default must be active/
  );
});

test('an inactive default makes catalog refresh fail closed', async () => {
  const service = createCatalogService({
    gateway: {},
    merchantId: 'inactive-default-merchant',
    discover: async () => [
      discovered('inactive-default', 'GBP', {
        isDefault: true,
        status: 'suspended',
      }),
      discovered('active-secondary', 'EUR'),
    ],
    policyLoader: async () => ({ policy: null, warnings: [] }),
  });

  const state = await service.refresh();

  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'INVALID_DISCOVERY_RESULT');
  assert.deepEqual(state.accounts, []);
  assert.throws(() => service.getMerchantAccounts(), CatalogUnavailableError);
});

test('refresh failure clears the previous catalog and never serves a cached fallback', async () => {
  let shouldFail = false;
  const service = createCatalogService({
    gateway: {},
    merchantId: 'refresh-merchant',
    discover: async () => {
      if (shouldFail) throw new Error('secret upstream failure');
      return [discovered('current-account', 'GBP', { isDefault: true })];
    },
    policyLoader: async () => ({ policy: null, warnings: [] }),
    now: () => new Date('2026-10-15T10:00:00.000Z'),
  });

  assert.equal((await service.refresh()).status, 'ok');
  assert.equal(service.hasMerchantAccountId('current-account'), true);

  shouldFail = true;
  const failed = await service.refresh();
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.accounts, []);
  assert.equal(failed.discoveredAt, null);
  assert.equal(JSON.stringify(failed).includes('secret upstream failure'), false);
  assert.throws(() => service.getMerchantAccounts(), CatalogUnavailableError);
});

test('concurrent refresh calls share discovery and later refreshes replace account membership', async () => {
  let discoveryCalls = 0;
  let release;
  let accounts = [discovered('first-account', 'GBP', { isDefault: true })];
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createCatalogService({
    gateway: {},
    merchantId: 'changing-merchant',
    discover: async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) await gate;
      return accounts;
    },
    policyLoader: async () => ({ policy: null, warnings: [] }),
  });

  const first = service.refresh();
  const same = service.refresh();
  assert.strictEqual(first, same);
  release();
  await first;
  assert.equal(discoveryCalls, 1);

  accounts = [discovered('replacement-account', 'EUR', { isDefault: true })];
  await service.refresh();
  assert.equal(discoveryCalls, 2);
  assert.throws(
    () => service.assertMerchantAccountId('first-account'),
    MerchantAccountNotFoundError
  );
  assert.equal(service.assertMerchantAccountId('replacement-account'), 'replacement-account');
});

test('inactive discovered IDs cannot pass the gateway membership invariant', async () => {
  const service = createCatalogService({
    gateway: {},
    merchantId: 'active-only-merchant',
    discover: async () => [
      discovered('active-default', 'GBP', { isDefault: true }),
      discovered('inactive-account', 'EUR', { status: 'suspended' }),
    ],
    policyLoader: async () => ({ policy: null, warnings: [] }),
  });
  await service.refresh();

  assert.equal(service.getMerchantAccountById('inactive-account').status, 'suspended');
  assert.equal(service.hasMerchantAccountId('inactive-account'), false);
  assert.throws(
    () => service.assertMerchantAccountId('inactive-account'),
    MerchantAccountNotFoundError
  );
});

test('state and account accessors return frozen defensive copies', async () => {
  const service = createCatalogService({
    gateway: {},
    merchantId: 'copy-merchant',
    discover: async () => [discovered('copy-account', 'GBP', { isDefault: true })],
    policyLoader: async () => ({ policy: null, warnings: [] }),
  });
  await service.refresh();

  const first = service.getMerchantAccounts();
  const second = service.getMerchantAccounts();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first[0]));
  assert.throws(() => first[0].paymentTypes.push('other'), TypeError);
  assert.ok(Object.isFrozen(service.getState()));
});

test('non-sandbox catalog configuration is rejected before discovery', () => {
  assert.throws(
    () => createCatalogService({
      gateway: {},
      merchantId: 'production-merchant',
      environment: 'production',
    }),
    /restricted to Sandbox/
  );
});

test('refresh fails closed when a discovered currency has no configured demo rate', async () => {
  const service = createCatalogService({
    gateway: {},
    merchantId: 'unknown-currency-merchant',
    discover: async () => [
      discovered('unknown-currency-account', 'ZZZ', { isDefault: true }),
    ],
    policyLoader: async () => ({ policy: null, warnings: [] }),
  });

  const state = await service.refresh();

  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'DEMO_RATE_CONFIGURATION_INVALID');
  assert.match(state.error.message, /fixed demo-rate configuration/i);
  assert.deepEqual(state.accounts, []);
  assert.throws(() => service.getMerchantAccounts(), CatalogUnavailableError);
});
