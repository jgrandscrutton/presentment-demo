'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApiRouter,
  getStorefrontRoutes,
} = require('../routes/api');

function account(
  merchantAccountId,
  currency,
  paymentTypes,
  { isDefault = false, status = 'active' } = {}
) {
  return {
    key: merchantAccountId,
    label: `${currency} ${merchantAccountId}`,
    merchantAccountId,
    currency,
    paymentTypes: [...paymentTypes],
    paymentTypeSources: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'policy'])
    ),
    routingReasons: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'Matched by test policy'])
    ),
    purpose: 'Dynamic storefront test fixture',
    environment: 'sandbox',
    status,
    isDefault,
    roleSource: paymentTypes.length > 0 ? 'policy' : null,
    assignmentState: paymentTypes.length > 0 ? 'assigned' : 'available_not_assigned',
  };
}

const JPY_ACCOUNTS = Object.freeze([
  account('jpy-sales-route', 'JPY', ['one_time'], { isDefault: true }),
  account('jpy-recurring-route', 'JPY', ['recurring']),
  account('cad-combined-route', 'CAD', ['one_time', 'recurring']),
]);

function catalogService({ status = 'ok', accounts = JPY_ACCOUNTS } = {}) {
  return {
    getState() {
      return {
        status,
        gatewayMerchantId: 'storefront-gateway',
        discoveredAt: status === 'ok' ? '2026-10-15T11:00:00.000Z' : null,
        error:
          status === 'ok'
            ? null
            : { code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED', message: 'Discovery unavailable.' },
        accounts: status === 'ok' ? structuredClone(accounts) : [],
      };
    },
    getMerchantAccounts() {
      if (status !== 'ok') {
        throw Object.assign(new Error('Discovery unavailable.'), {
          code: 'CATALOG_UNAVAILABLE',
        });
      }
      return structuredClone(accounts);
    },
  };
}

function fakeStore() {
  const events = [];
  return {
    events,
    append(event) {
      const stored = { ...structuredClone(event), id: `event-${events.length + 1}` };
      events.push(stored);
      return structuredClone(stored);
    },
  };
}

function invoke(router, method, routePath, body = {}, query = {}) {
  const normalizedMethod = method.toLowerCase();
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === routePath &&
      candidate.route.methods[normalizedMethod]
  );
  if (!layer) throw new Error(`No ${method} route registered for ${routePath}`);

  return new Promise((resolve, reject) => {
    let sent = false;
    const req = {
      body,
      query,
      method: method.toUpperCase(),
      path: routePath,
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        sent = true;
        resolve({ status: this.statusCode, body: structuredClone(payload) });
        return this;
      },
      send(payload) {
        sent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };

    try {
      Promise.resolve(layer.route.stack[0].handle(req, res, reject)).then(
        () => {
          if (!sent) reject(new Error(`${method} ${routePath} sent no response`));
        },
        reject
      );
    } catch (error) {
      reject(error);
    }
  });
}

function harness({
  status = 'ok',
  accounts = JPY_ACCOUNTS,
  saleResult,
} = {}) {
  const calls = { clientToken: [], sale: [] };
  const store = fakeStore();
  const gatewayClient = {
    async generateClientToken(request) {
      calls.clientToken.push(structuredClone(request));
      return 'dynamic-client-token';
    },
    async createSale(request) {
      calls.sale.push(structuredClone(request));
      if (typeof saleResult === 'function') return saleResult(request);
      if (saleResult) return saleResult;
      return {
        success: true,
        message: 'Approved',
        transaction: {
          id: `transaction-${calls.sale.length}`,
          status: 'submitted_for_settlement',
          amount: request.amount,
          currencyIsoCode: 'JPY',
          merchantAccountId: request.merchantAccountId,
          paymentInstrumentType: 'paypal_account',
        },
      };
    },
  };
  const service = catalogService({ status, accounts });
  const router = createApiRouter({
    catalogService: service,
    gatewayClient,
    store,
    logger: { error() {} },
  });

  return {
    calls,
    gatewayClient,
    router,
    service,
    store,
    get(path, query) {
      return invoke(router, 'GET', path, {}, query);
    },
    post(path, body) {
      return invoke(router, 'POST', path, body);
    },
  };
}

test('storefront routes are derived only from the discovered default currency', () => {
  const routes = getStorefrontRoutes(catalogService({ accounts: JPY_ACCOUNTS }));

  assert.equal(routes.currency, 'JPY');
  assert.equal(routes.oneTime.account.merchantAccountId, 'jpy-sales-route');
  assert.equal(routes.recurring.account.merchantAccountId, 'jpy-recurring-route');
});

test('client tokens, one-time sale, and recurring sale use dynamic default-currency routes', async () => {
  const demo = harness();

  const token = await demo.get('/client-token');
  assert.equal(token.status, 200);
  assert.equal(token.body, 'dynamic-client-token');
  assert.deepEqual(demo.calls.clientToken, [
    { merchantAccountId: 'jpy-sales-route' },
  ]);

  const recurringToken = await demo.get('/client-token', {
    paymentType: 'recurring',
  });
  assert.equal(recurringToken.status, 200);
  assert.equal(recurringToken.body, 'dynamic-client-token');
  assert.deepEqual(demo.calls.clientToken, [
    { merchantAccountId: 'jpy-sales-route' },
    { merchantAccountId: 'jpy-recurring-route' },
  ]);

  const transaction = await demo.post('/create-transaction', {
    amount: '10',
    currency: 'JPY',
    nonce: 'fake-jpy-nonce',
    description: 'dynamic-order',
  });
  assert.equal(transaction.status, 200);
  assert.equal(transaction.body.success, true);
  assert.equal(transaction.body.amount, '10');
  assert.equal(transaction.body.currency, 'JPY');
  assert.equal(demo.calls.sale[0].merchantAccountId, 'jpy-sales-route');
  assert.equal(demo.calls.sale[0].amount, '10');

  const subscription = await demo.post('/create-subscription', {
    nonce: 'fake-recurring-nonce',
    billingData: {
      type: 'subscription',
      planDetails: {
        amount: '30',
        currencyIsoCode: 'JPY',
      },
    },
  });
  assert.equal(subscription.status, 200);
  assert.equal(subscription.body.success, true);
  assert.equal(subscription.body.currency, 'JPY');
  assert.equal(demo.calls.sale[1].merchantAccountId, 'jpy-recurring-route');
  assert.equal(demo.calls.sale[1].amount, '30');
});

test('invalid or merchant-account client-token intent is rejected before the gateway', async () => {
  const demo = harness();

  const invalidType = await demo.get('/client-token', {
    paymentType: 'subscription',
  });
  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.body.code, 'INVALID_PAYMENT_TYPE');

  const injectedAccount = await demo.get('/client-token', {
    paymentType: 'recurring',
    merchantAccountId: 'attacker-selected-account',
  });
  assert.equal(injectedAccount.status, 400);
  assert.equal(injectedAccount.body.code, 'INVALID_CLIENT_TOKEN_INTENT');
  assert.deepEqual(demo.calls.clientToken, []);
  assert.deepEqual(demo.store.events, []);
});

test('zero-decimal storefront amounts reject any decimal point before sale', async () => {
  const demo = harness();

  const transaction = await demo.post('/create-transaction', {
    amount: '10.00',
    currency: 'JPY',
    nonce: 'fake-jpy-nonce',
  });
  assert.equal(transaction.status, 400);
  assert.equal(transaction.body.code, 'INVALID_AMOUNT');

  const plan = await demo.post('/create-billing-plan', {
    type: 'subscription',
    description: 'JPY plan',
    frequency: 'monthly',
    amount: '30.00',
    currency: 'JPY',
  });
  assert.equal(plan.status, 400);
  assert.equal(plan.body.code, 'INVALID_PLAN');
  assert.deepEqual(demo.calls.sale, []);
});

test('client currency mismatch is blocked and a gateway route mismatch is never reported as success', async () => {
  const currencyMismatch = harness();
  const rejected = await currencyMismatch.post('/create-transaction', {
    amount: '10',
    currency: 'CAD',
    nonce: 'fake-jpy-nonce',
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'STOREFRONT_CURRENCY_MISMATCH');
  assert.deepEqual(currencyMismatch.calls.sale, []);

  const routeMismatch = harness({
    saleResult(request) {
      return {
        success: true,
        message: 'Approved',
        transaction: {
          id: 'wrong-route-transaction',
          status: 'submitted_for_settlement',
          amount: request.amount,
          currencyIsoCode: 'JPY',
          merchantAccountId: 'another-jpy-account',
        },
      };
    },
  });
  const response = await routeMismatch.post('/create-transaction', {
    amount: '10',
    currency: 'JPY',
    nonce: 'fake-jpy-nonce',
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.success, false);
  assert.equal(response.body.code, 'ROUTE_VERIFICATION_FAILED');
  assert.equal(response.body.verification.passed, false);
  assert.equal(
    response.body.verification.expectedMerchantAccountId,
    'jpy-sales-route'
  );
  assert.equal(
    response.body.verification.actualMerchantAccountId,
    'another-jpy-account'
  );
});

test('an unavailable catalog blocks every storefront Braintree call', async () => {
  const demo = harness({ status: 'failed', accounts: [] });
  const requests = [
    demo.get('/client-token'),
    demo.post('/create-transaction', {
      amount: '10',
      currency: 'JPY',
      nonce: 'fake-jpy-nonce',
    }),
    demo.post('/create-subscription', {
      nonce: 'fake-recurring-nonce',
      billingData: {
        type: 'subscription',
        planDetails: { amount: '30', currencyIsoCode: 'JPY' },
      },
    }),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'CATALOG_UNAVAILABLE');
  }
  assert.deepEqual(demo.calls, { clientToken: [], sale: [] });
  assert.deepEqual(demo.store.events, []);
});

test('the storefront never falls back to a non-default currency with complete routes', async () => {
  const accounts = [
    account('default-cad-sales', 'CAD', ['one_time'], { isDefault: true }),
    account('eur-combined', 'EUR', ['one_time', 'recurring']),
  ];
  const demo = harness({ accounts });

  assert.throws(
    () => getStorefrontRoutes(demo.service),
    (error) => error.code === 'CATALOG_UNAVAILABLE' && /CAD/.test(error.message)
  );
  const response = await demo.get('/client-token');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'CATALOG_UNAVAILABLE');
  assert.deepEqual(demo.calls, { clientToken: [], sale: [] });
});
