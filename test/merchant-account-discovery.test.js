'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MerchantAccountGateway,
} = require('braintree/lib/braintree/merchant_account_gateway');

const {
  MerchantAccountDiscoveryError,
  discoverMerchantAccounts,
} = require('../lib/braintree/discover-merchant-accounts');

function rawAccount(id, currencyIsoCode, options = {}) {
  return {
    id,
    currencyIsoCode,
    status: options.status || 'active',
    default: options.isDefault === true,
  };
}

test('discovery uses the SDK all callback and normalizes the fully collected result', async () => {
  let allCalls = 0;
  const gateway = {
    merchantAccount: {
      all(callback) {
        allCalls += 1;
        setImmediate(() => callback(null, [
          rawAccount('account-b', 'usd'),
          rawAccount('account-a', 'gbp', { isDefault: true }),
          rawAccount('account-c', 'jpy', { status: 'suspended' }),
        ]));
      },
    },
  };

  const accounts = await discoverMerchantAccounts(gateway);

  assert.equal(allCalls, 1);
  assert.deepEqual(accounts, [
    {
      merchantAccountId: 'account-b',
      currency: 'USD',
      status: 'active',
      isDefault: false,
    },
    {
      merchantAccountId: 'account-a',
      currency: 'GBP',
      status: 'active',
      isDefault: true,
    },
    {
      merchantAccountId: 'account-c',
      currency: 'JPY',
      status: 'suspended',
      isDefault: false,
    },
  ]);
  assert.ok(Object.isFrozen(accounts));
  assert.ok(accounts.every(Object.isFrozen));
});

test('the SDK all callback collects every merchant-account page before discovery normalizes it', async () => {
  const requestedPages = [];
  const pages = new Map([
    [
      1,
      [
        rawAccount('page-one-default', 'gbp', { isDefault: true }),
        rawAccount('page-one-usd', 'usd'),
      ],
    ],
    [2, [rawAccount('page-two-jpy', 'jpy', { status: 'suspended' })]],
  ]);
  const sdkGateway = {
    config: {
      baseMerchantPath: () => '/merchants/paginated-fixture',
    },
    http: {
      get(url, callback) {
        const page = Number(
          new URL(url, 'https://sandbox.braintree.test').searchParams.get('page')
        );
        requestedPages.push(page);
        setImmediate(() => callback(null, {
          merchantAccounts: {
            totalItems: 3,
            pageSize: 2,
            merchantAccount: pages.get(page),
          },
        }));
      },
    },
  };
  const gateway = {
    merchantAccount: new MerchantAccountGateway(sdkGateway),
  };

  const accounts = await discoverMerchantAccounts(gateway);

  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(
    accounts.map((account) => account.merchantAccountId),
    ['page-one-default', 'page-one-usd', 'page-two-jpy']
  );
  assert.equal(accounts[2].status, 'suspended');
});

test('discovery returns safe typed failures for SDK and empty-result errors', async () => {
  await assert.rejects(
    discoverMerchantAccounts({
      merchantAccount: {
        all(callback) {
          callback(new Error('secret provider detail'));
        },
      },
    }),
    (error) =>
      error instanceof MerchantAccountDiscoveryError &&
      error.code === 'MERCHANT_ACCOUNT_DISCOVERY_FAILED' &&
      !error.message.includes('secret provider detail')
  );

  await assert.rejects(
    discoverMerchantAccounts({
      merchantAccount: { all: (callback) => callback(null, []) },
    }),
    (error) =>
      error instanceof MerchantAccountDiscoveryError &&
      error.code === 'EMPTY_DISCOVERY_RESULT'
  );
});
