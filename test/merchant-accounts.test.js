'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  configureCatalogService,
  getMerchantAccountByKey,
  getMerchantAccountCatalogState,
  getMerchantAccounts,
  getPublicMerchantAccounts,
  refreshMerchantAccounts,
  validateMerchantAccounts,
} = require('../config/merchant-accounts');
const {
  resetRuntimeCatalogServiceForTests,
} = require('../lib/catalog/runtime');
const { createCatalogService } = require('../lib/catalog/service');

test.afterEach(() => resetRuntimeCatalogServiceForTests());

function makeService() {
  return createCatalogService({
    gateway: {},
    merchantId: 'config-fixture',
    discover: async () => [{
      merchantAccountId: 'dynamic-account',
      currency: 'CAD',
      status: 'active',
      isDefault: true,
    }],
    policyLoader: async () => ({ policy: null, warnings: [] }),
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  });
}

test('config accessors expose only the configured runtime catalog', async () => {
  const service = configureCatalogService(makeService());
  await refreshMerchantAccounts();

  const accounts = getMerchantAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].merchantAccountId, 'dynamic-account');
  assert.equal(getMerchantAccountByKey('dynamic-account').currency, 'CAD');
  assert.deepEqual(getPublicMerchantAccounts(), accounts);
  assert.deepEqual(getMerchantAccountCatalogState(), service.getState());
});

test('catalog schema permits unassigned accounts but rejects duplicate active routes', () => {
  const base = {
    key: 'default-account',
    label: 'GBP account (default-account)',
    merchantAccountId: 'default-account',
    currency: 'GBP',
    paymentTypes: ['one_time', 'recurring'],
    purpose: 'Automatically assigned.',
    environment: 'sandbox',
    status: 'active',
    isDefault: true,
  };
  const available = {
    ...base,
    key: 'available-account',
    merchantAccountId: 'available-account',
    label: 'GBP account (available-account)',
    paymentTypes: [],
    purpose: 'Available, not assigned.',
    isDefault: false,
  };

  assert.equal(validateMerchantAccounts([base, available]), true);
  assert.throws(
    () => validateMerchantAccounts([
      base,
      { ...available, paymentTypes: ['one_time'] },
    ]),
    /Duplicate active routing target/
  );
  assert.throws(
    () => validateMerchantAccounts([{ ...base, status: 'suspended' }]),
    /default account must be active/
  );
});
