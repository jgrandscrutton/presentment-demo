'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const exphbs = require('express-handlebars');

const {
  ALL_FILTER,
  LEGACY_FILTER,
  buildDemoLogViewModel,
  createDemoLogRouter,
} = require('../routes/demo-log');

const template = exphbs.create({ extname: '.hbs' });

function currentAccount(overrides = {}) {
  return {
    merchantAccountId: 'account-cad',
    key: 'account-cad',
    label: 'Canada Store',
    currency: 'CAD',
    status: 'active',
    isDefault: true,
    paymentTypes: ['one_time', 'recurring'],
    ...overrides,
  };
}

function catalogService(overrides = {}) {
  const accounts = overrides.accounts || [currentAccount()];
  const state = {
    status: 'ok',
    gatewayMerchantId: 'gateway-current',
    accounts,
    ...overrides.state,
  };
  return {
    getState() {
      return structuredClone(state);
    },
    getPublicMerchantAccounts() {
      return structuredClone(accounts);
    },
  };
}

function events() {
  return [
    {
      id: 'route-current',
      timestamp: '2026-10-20T08:59:00.000Z',
      gatewayMerchantId: 'gateway-current',
      type: 'route_resolution',
      scenarioId: 'cad-one-time',
      intent: { currency: 'CAD', paymentType: 'one_time' },
      resolvedMerchantAccountId: 'account-cad',
      responseMerchantAccountId: null,
      verified: null,
      paymentMethodType: 'card',
      amount: null,
      currency: 'CAD',
      outcome: 'matched',
      braintreeId: null,
      relatedEventId: null,
      request: { currency: 'CAD', paymentType: 'one_time' },
      response: null,
    },
    {
      id: 'transaction-current',
      timestamp: '2026-10-20T09:00:00.000Z',
      gatewayMerchantId: 'gateway-current',
      type: 'transaction',
      scenarioId: 'cad-authorize',
      intent: { currency: 'CAD', paymentType: 'one_time' },
      resolvedMerchantAccountId: 'account-cad',
      responseMerchantAccountId: 'account-cad',
      verified: true,
      paymentMethodType: 'credit_card',
      amount: '10.00',
      currency: 'CAD',
      outcome: 'authorized',
      transactionStatus: 'authorized',
      braintreeId: 'txn-current',
      relatedEventId: null,
      request: { currency: 'CAD', paymentType: 'one_time', amount: '10.00' },
      response: {
        success: true,
        transaction: {
          id: 'txn-current',
          status: 'authorized',
          merchantAccountId: 'account-cad',
          currencyIsoCode: 'CAD',
          amount: '10.00',
        },
      },
    },
    {
      id: 'action-current',
      timestamp: '2026-10-20T09:01:00.000Z',
      gatewayMerchantId: 'gateway-current',
      type: 'transaction_action',
      action: 'capture',
      scenarioId: 'cad-authorize',
      intent: { currency: 'CAD', paymentType: 'one_time' },
      resolvedMerchantAccountId: 'account-cad',
      responseMerchantAccountId: 'account-cad',
      verified: true,
      paymentMethodType: 'credit_card',
      amount: '5.00',
      currency: 'CAD',
      outcome: 'succeeded',
      braintreeId: 'txn-current',
      originalBraintreeId: 'txn-current',
      relatedEventId: 'transaction-current',
      request: { action: 'capture', amount: '5.00' },
      response: { success: true, transaction: { status: 'submitted_for_settlement' } },
    },
    {
      id: 'transaction-historical',
      timestamp: '2026-10-19T09:00:00.000Z',
      gatewayMerchantId: 'gateway-historical',
      type: 'transaction',
      scenarioId: 'historic-eur',
      intent: { currency: 'EUR', paymentType: 'one_time' },
      resolvedMerchantAccountId: 'historic-eur-account',
      responseMerchantAccountId: 'historic-eur-account',
      verified: true,
      paymentMethodType: 'credit_card',
      amount: '12.00',
      currency: 'EUR',
      outcome: 'succeeded',
      braintreeId: 'txn-historical',
      relatedEventId: null,
      request: {},
      response: { success: true },
    },
    {
      id: 'transaction-legacy',
      timestamp: '2026-10-18T09:00:00.000Z',
      type: 'transaction',
      scenarioId: 'legacy-gbp',
      intent: { currency: 'GBP', paymentType: 'one_time' },
      resolvedMerchantAccountId: 'legacy-account',
      responseMerchantAccountId: 'legacy-account',
      verified: true,
      paymentMethodType: 'credit_card',
      amount: '9.00',
      currency: 'GBP',
      outcome: 'succeeded',
      braintreeId: 'txn-legacy',
      relatedEventId: null,
      request: {},
      response: { success: true },
    },
  ];
}

function storeWith(source = events()) {
  return {
    list() {
      return structuredClone(source);
    },
  };
}

test('transaction log defaults to the connected gateway and exposes only eligible root operations', () => {
  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith(),
  });

  assert.equal(model.selectedGateway, 'gateway-current');
  assert.equal(model.visibleCount, 3);
  assert.equal(model.totalCount, 5);
  assert.deepEqual(
    model.rows.map((row) => row.id),
    ['action-current', 'transaction-current', 'route-current']
  );
  assert.equal(
    model.rows.find((row) => row.id === 'transaction-current').canOperate,
    true
  );
  assert.equal(
    model.rows.find((row) => row.id === 'action-current').canOperate,
    false
  );
  assert.equal(
    model.rows.find((row) => row.id === 'transaction-current').accountLabel,
    'Canada Store'
  );
  assert.ok(model.gatewayOptions.some(
    (entry) => entry.value === 'gateway-historical' && /Historical/.test(entry.label)
  ));
  assert.ok(model.gatewayOptions.some((entry) => entry.value === LEGACY_FILTER));
});

test('gateway, currency, and merchant-account filters compose without enabling history', () => {
  const historical = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith(),
    query: {
      gateway: 'gateway-historical',
      currency: 'EUR',
      account: 'historic-eur-account',
    },
  });
  assert.deepEqual(historical.rows.map((row) => row.id), ['transaction-historical']);
  assert.equal(historical.rows[0].canOperate, false);
  assert.match(historical.rows[0].operationReason, /Historical|legacy/i);

  const legacy = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith(),
    query: { gateway: LEGACY_FILTER },
  });
  assert.deepEqual(legacy.rows.map((row) => row.id), ['transaction-legacy']);
  assert.equal(legacy.rows[0].canOperate, false);

  const invalid = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith(),
    query: { gateway: 'untrusted-gateway', currency: 'ZZZ', account: '<script>' },
  });
  assert.equal(invalid.selectedGateway, 'gateway-current');
  assert.equal(invalid.selectedCurrency, ALL_FILTER);
  assert.equal(invalid.selectedAccount, ALL_FILTER);
});

test('transaction log template escapes event and catalog values and renders no reset control', async () => {
  const unsafeEvents = events();
  unsafeEvents[1].scenarioId = '<script>alert(1)</script>';
  unsafeEvents[1].request.note = '</pre><img src=x onerror=alert(1)>';
  const model = buildDemoLogViewModel({
    service: catalogService({
      accounts: [currentAccount({ label: '<unsafe account label>' })],
    }),
    store: storeWith(unsafeEvents),
  });
  const html = await template.render(
    path.join(__dirname, '..', 'views', 'demo-log.hbs'),
    model
  );

  assert.match(html, /Transaction activity/);
  assert.match(html, /data-event-id="transaction-current"/);
  assert.match(html, /Checking live Braintree status/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;unsafe account label&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /clear log|reset demo/i);
  assert.doesNotMatch(html, /<style>/i);
});

test('log router resolves the current catalog service for every request', () => {
  const services = [
    catalogService({ state: { gatewayMerchantId: 'gateway-one' } }),
    catalogService({ state: { gatewayMerchantId: 'gateway-two' } }),
  ];
  let reads = 0;
  const router = createDemoLogRouter({
    getCatalogService() {
      return services[reads++];
    },
    store: storeWith([]),
  });
  const handler = router.stack.find((layer) => layer.route?.path === '/')
    .route.stack[0].handle;
  const rendered = [];
  const response = {
    render(view, model) {
      rendered.push({ view, model });
    },
  };

  handler({ query: {} }, response, assert.fail);
  handler({ query: {} }, response, assert.fail);

  assert.equal(reads, 2);
  assert.equal(rendered[0].view, 'demo-log');
  assert.equal(rendered[0].model.currentGateway, 'gateway-one');
  assert.equal(rendered[1].model.currentGateway, 'gateway-two');
});
