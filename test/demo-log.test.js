'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const exphbs = require('express-handlebars');

const {
  ALL_FILTER,
  LEGACY_FILTER,
  RESET_CONFIRMATION_HEADER,
  RESET_CONFIRMATION_VALUE,
  RESET_SCOPE,
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
      threeDSecurePolicy: 'required',
      threeDSecureStatus: 'authenticate_successful',
      liabilityShiftPossible: true,
      liabilityShifted: true,
      threeDSecureVerification: {
        policy: 'required',
        performed: true,
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
        passed: true,
      },
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

function storeWith(source = events(), overrides = {}) {
  let stored = structuredClone(source);
  return {
    list() {
      return structuredClone(stored);
    },
    clear() {
      const removed = stored.length;
      stored = [];
      return removed;
    },
    ...overrides,
  };
}

function resetHandler(router) {
  return router.stack.find(
    (layer) => layer.route?.path === '/reset' && layer.route.methods.post
  ).route.stack[0].handle;
}

function resetRequest({ json = true, confirmation = RESET_CONFIRMATION_VALUE, scope = RESET_SCOPE } = {}) {
  return {
    body: { scope },
    is(type) {
      return json && type === 'application/json' ? 'application/json' : false;
    },
    get(name) {
      return name === RESET_CONFIRMATION_HEADER ? confirmation : undefined;
    },
  };
}

function jsonResponse() {
  const result = { statusCode: null, body: null };
  return {
    result,
    status(statusCode) {
      result.statusCode = statusCode;
      return this;
    },
    json(body) {
      result.body = body;
      return body;
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
  assert.equal(
    model.rows.find((row) => row.id === 'transaction-current').paymentMethodLabel,
    'Card'
  );
  assert.equal(
    model.rows.find((row) => row.id === 'transaction-current').threeDSecureLabel,
    'Required · Authenticated · Liability shifted'
  );
  assert.equal(
    model.rows.find((row) => row.id === 'transaction-current').threeDSecureClass,
    'is-verified'
  );
  assert.equal(
    model.rows.find((row) => row.id === 'route-current').operationHeading,
    'Recorded event'
  );
  assert.match(
    model.rows.find((row) => row.id === 'route-current').operationReason,
    /lifecycle controls/
  );
  assert.ok(model.gatewayOptions.some(
    (entry) => entry.value === 'gateway-historical' && /Historical/.test(entry.label)
  ));
  assert.ok(model.gatewayOptions.some((entry) => entry.value === LEGACY_FILTER));
});

test('recurring mandate evidence is labelled as vault setup rather than transaction authentication', () => {
  const recurringSetupEvent = {
    ...events().find((event) => event.id === 'transaction-current'),
    id: 'recurring-setup-current',
    recurringModel: 'merchant_managed',
    transactionSource: 'recurring_first',
    threeDSecureEvidenceScope: 'vault_setup',
    transactionThreeDSecureAuthenticated: false,
    threeDSecureVerification: {
      policy: 'required',
      performed: true,
      status: 'authenticate_successful',
      liabilityShiftPossible: true,
      liabilityShifted: true,
      passed: true,
      evidenceScope: 'vault_setup',
      transactionAuthenticated: false,
    },
  };
  const setupWithoutAuthenticationFlag = {
    ...recurringSetupEvent,
    id: 'recurring-setup-without-authentication-flag',
    transactionThreeDSecureAuthenticated: null,
    threeDSecureVerification: {
      ...recurringSetupEvent.threeDSecureVerification,
    },
  };
  delete setupWithoutAuthenticationFlag.threeDSecureVerification
    .transactionAuthenticated;
  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith([recurringSetupEvent, setupWithoutAuthenticationFlag]),
  });
  const byId = new Map(model.rows.map((row) => [row.id, row]));

  assert.equal(model.rows.length, 2);
  assert.equal(
    byId.get('recurring-setup-current').threeDSecureLabel,
    'Vault setup · Authenticated · Setup liability shifted'
  );
  assert.equal(
    byId.get('recurring-setup-current').threeDSecureClass,
    'is-neutral'
  );
  assert.equal(
    byId.get('recurring-setup-without-authentication-flag').threeDSecureLabel,
    'Vault setup · Authenticated · Setup liability shifted'
  );
  assert.equal(
    byId.get('recurring-setup-without-authentication-flag').threeDSecureClass,
    'is-neutral'
  );
});

test('recurring evidence fails neutral when scope is legacy or transaction authentication is explicitly false', () => {
  const legacyRecurring = {
    ...events().find((event) => event.id === 'transaction-current'),
    id: 'legacy-recurring-setup',
    recurringModel: 'merchant_managed',
    transactionSource: 'recurring_first',
  };
  const unauthenticatedSubscription = {
    ...events().find((event) => event.id === 'transaction-current'),
    id: 'unauthenticated-subscription-transaction',
    type: 'subscription',
    recurringModel: 'braintree_subscription',
    transactionSource: null,
    threeDSecureEvidenceScope: 'subscription_transaction',
    transactionThreeDSecureAuthenticated: false,
    threeDSecureVerification: {
      policy: 'required',
      performed: true,
      status: 'authenticate_successful',
      liabilityShiftPossible: true,
      liabilityShifted: true,
      passed: true,
      evidenceScope: 'subscription_transaction',
      transactionAuthenticated: false,
    },
  };
  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith([legacyRecurring, unauthenticatedSubscription]),
  });
  const byId = new Map(model.rows.map((row) => [row.id, row]));

  assert.equal(
    byId.get('legacy-recurring-setup').threeDSecureLabel,
    'Recurring evidence · Scope unavailable · Transaction authentication not established'
  );
  assert.equal(
    byId.get('legacy-recurring-setup').threeDSecureClass,
    'is-neutral'
  );
  assert.equal(
    byId.get('unauthenticated-subscription-transaction').threeDSecureLabel,
    'Subscription transaction · Transaction not authenticated'
  );
  assert.equal(
    byId.get('unauthenticated-subscription-transaction').threeDSecureClass,
    'is-neutral'
  );
});

test('transaction log presents canonical payment-method labels without rewriting evidence', () => {
  const paypalEvent = events()[1];
  paypalEvent.id = 'transaction-paypal';
  paypalEvent.paymentMethodType = 'paypal_account';
  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith([paypalEvent]),
  });

  assert.equal(model.rows[0].paymentMethodLabel, 'PayPal');
  assert.equal(model.rows[0].threeDSecureLabel, 'Not applicable · PayPal');
  assert.equal(model.rows[0].paymentMethodType, 'paypal_account');
  assert.match(model.rows[0].inspectorJson, /"paymentMethodType": "paypal_account"/);
});

test('transaction log distinguishes failed, optional, and legacy 3D Secure proof', () => {
  const failed = events()[1];
  failed.id = 'transaction-failed-3ds';
  failed.verified = false;
  failed.threeDSecurePolicy = 'required';
  failed.threeDSecureStatus = 'authenticate_rejected';
  failed.liabilityShifted = false;
  failed.threeDSecureVerification = {
    policy: 'required',
    performed: true,
    status: 'authenticate_rejected',
    liabilityShifted: false,
    passed: false,
  };

  const optional = events()[1];
  optional.id = 'transaction-optional-3ds';
  optional.threeDSecurePolicy = 'optional';
  optional.threeDSecureStatus = null;
  optional.liabilityShifted = null;
  optional.threeDSecureVerification = {
    policy: 'optional',
    performed: false,
    status: null,
    liabilityShifted: null,
    passed: true,
  };

  const legacy = events()[1];
  legacy.id = 'transaction-without-3ds-fields';
  delete legacy.threeDSecurePolicy;
  delete legacy.threeDSecureStatus;
  delete legacy.liabilityShiftPossible;
  delete legacy.liabilityShifted;
  delete legacy.threeDSecureVerification;

  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith([failed, optional, legacy]),
  });
  const byId = new Map(model.rows.map((row) => [row.id, row]));

  assert.equal(
    byId.get('transaction-failed-3ds').threeDSecureLabel,
    'Required · Authentication rejected · Liability not shifted'
  );
  assert.equal(byId.get('transaction-failed-3ds').threeDSecureClass, 'is-failed');
  assert.equal(
    byId.get('transaction-optional-3ds').threeDSecureLabel,
    'Optional · Not performed · Shift unavailable'
  );
  assert.equal(byId.get('transaction-optional-3ds').threeDSecureClass, 'is-neutral');
  assert.equal(byId.get('transaction-without-3ds-fields').threeDSecureLabel, 'Not recorded');
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

test('transaction log template escapes values and explains the local-only reset boundary', async () => {
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
  assert.match(html, /Stage 7/);
  assert.match(html, /3D Secure/);
  assert.match(html, /data-event-id="transaction-current"/);
  assert.match(html, /Checking live Braintree status/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;unsafe account label&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
  assert.match(html, /Reset local demo/);
  assert.match(
    html,
    /Braintree transactions, subscriptions, customers, payment methods, and disputes stay unchanged/
  );
  assert.match(html, /data-reset-confirmation="clear-local-demo-events"/);
  assert.doesNotMatch(html, /<style>/i);
});

test('local reset clears only the injected event store and has no gateway SDK dependency', () => {
  const accessed = [];
  let cleared = 0;
  const store = new Proxy({
    list() {
      return [];
    },
    clear() {
      cleared += 1;
      return 7;
    },
  }, {
    get(target, property, receiver) {
      accessed.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const router = createDemoLogRouter({
    catalogService: catalogService(),
    store,
  });
  const response = jsonResponse();

  resetHandler(router)(resetRequest(), response);

  assert.equal(cleared, 1);
  assert.equal(response.result.statusCode, 200);
  assert.deepEqual(response.result.body, {
    success: true,
    clearedLocalEvents: 7,
    braintreeObjectsChanged: false,
  });
  assert.deepEqual([...new Set(accessed)], ['clear']);
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'demo-log.js'),
    'utf8'
  );
  assert.doesNotMatch(
    routeSource,
    /require\(['"]\.\.\/lib\/braintree\/gateway['"]\)|gateway\.(?:transaction|customer|subscription|paymentMethod)/
  );
});

test('local reset requires JSON, the exact confirmation header, and the local-store scope', () => {
  let clearCalls = 0;
  const store = storeWith([], {
    clear() {
      clearCalls += 1;
      return 0;
    },
  });
  const router = createDemoLogRouter({ catalogService: catalogService(), store });
  const handler = resetHandler(router);
  const cases = [
    { request: resetRequest({ json: false }), status: 415, code: 'RESET_JSON_REQUIRED' },
    { request: resetRequest({ confirmation: 'yes' }), status: 400, code: 'RESET_CONFIRMATION_REQUIRED' },
    { request: resetRequest({ scope: 'gateway' }), status: 400, code: 'RESET_CONFIRMATION_REQUIRED' },
  ];

  for (const entry of cases) {
    const response = jsonResponse();
    handler(entry.request, response);
    assert.equal(response.result.statusCode, entry.status);
    assert.equal(response.result.body.error.code, entry.code);
  }
  assert.equal(clearCalls, 0);
});

test('local reset failure is safe and never implies a Braintree change', () => {
  const router = createDemoLogRouter({
    catalogService: catalogService(),
    store: storeWith([], {
      clear() {
        throw new Error('sensitive filesystem diagnostic');
      },
    }),
  });
  const response = jsonResponse();

  resetHandler(router)(resetRequest(), response);

  assert.equal(response.result.statusCode, 500);
  assert.equal(response.result.body.error.code, 'RESET_FAILED');
  assert.match(response.result.body.error.message, /Nothing in Braintree was changed/);
  assert.doesNotMatch(JSON.stringify(response.result.body), /sensitive filesystem diagnostic/);
});

test('subscription records receive a server-derived Sandbox Control Panel link', () => {
  const model = buildDemoLogViewModel({
    service: catalogService(),
    store: storeWith([{
      id: 'subscription-current',
      timestamp: '2026-10-20T09:00:00.000Z',
      gatewayMerchantId: 'gateway-current',
      type: 'subscription',
      scenarioId: 'cad-subscription',
      intent: { currency: 'CAD', paymentType: 'recurring' },
      resolvedMerchantAccountId: 'account-cad',
      responseMerchantAccountId: 'account-cad',
      verified: true,
      paymentMethodType: 'credit_card',
      amount: '10.00',
      currency: 'CAD',
      outcome: 'succeeded',
      subscriptionId: 'subscription_123',
      subscriptionStatus: 'Active',
      relatedEventId: null,
    }]),
  });

  assert.equal(model.rows[0].operationHeading, 'Recorded event');
  assert.equal(
    model.rows[0].controlPanelUrl,
    'https://sandbox.braintreegateway.com/merchants/gateway-current/subscriptions/subscription_123'
  );
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
