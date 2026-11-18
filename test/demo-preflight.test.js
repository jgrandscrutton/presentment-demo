'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const exphbs = require('express-handlebars');

const appModule = require('../app');
const {
  buildPreflightViewModel,
  createDemoPreflightRouter,
  webhookConfiguration,
} = require('../routes/demo-preflight');

const ROOT = path.join(__dirname, '..');
const handlebars = exphbs.create({
  extname: '.hbs',
  helpers: {
    eq: (left, right) => left === right,
    gt: (left, right) => left > right,
  },
});

function catalogState(overrides = {}) {
  return {
    status: 'ok',
    gatewayMerchantId: 'gateway-sandbox',
    discoveredAt: '2026-11-17T10:30:00.000Z',
    error: null,
    policyStatus: 'applied',
    warnings: [{
      code: 'POLICY_FALLBACK',
      message: 'A safe automatic assignment remains in use.',
    }],
    accounts: [
      {
        merchantAccountId: 'cad-main',
        label: 'Canada routing',
        currency: 'CAD',
        status: 'active',
        isDefault: true,
        paymentTypes: ['one_time', 'recurring'],
        paymentMethods: ['card', 'paypal'],
        threeDSecurePolicy: 'required',
      },
      {
        merchantAccountId: 'eur-recurring',
        label: 'Europe recurring',
        currency: 'EUR',
        status: 'active',
        isDefault: false,
        paymentTypes: ['recurring'],
        paymentMethods: ['card'],
        threeDSecurePolicy: 'optional',
      },
      {
        merchantAccountId: 'usd-inactive',
        label: 'Old US account',
        currency: 'USD',
        status: 'inactive',
        isDefault: false,
        paymentTypes: [],
        paymentMethods: [],
      },
    ],
    planDiscovery: {
      status: 'ok',
      discoveredAt: '2026-11-17T10:30:00.000Z',
      error: null,
    },
    plans: [{ id: 'cad-monthly', name: 'CAD monthly', currency: 'CAD' }],
    ...overrides,
  };
}

function catalogService(initialState = catalogState(), refreshState = initialState) {
  const calls = { getState: 0, refresh: 0 };
  return {
    calls,
    getState() {
      calls.getState += 1;
      return structuredClone(initialState);
    },
    async refresh() {
      calls.refresh += 1;
      return structuredClone(refreshState);
    },
  };
}

function eventStore(events = []) {
  return {
    list() {
      return structuredClone(events);
    },
  };
}

function webhookEvents() {
  return [
    {
      id: 'old-webhook',
      type: 'webhook',
      timestamp: '2026-11-16T09:00:00.000Z',
      webhookKind: 'subscription_charged_successfully',
      verified: true,
      relatedEventId: 'subscription-event',
    },
    { id: 'transaction', type: 'transaction', timestamp: '2026-11-17T09:10:00.000Z' },
    {
      id: 'latest-webhook',
      type: 'webhook',
      timestamp: '2026-11-17T09:15:00.000Z',
      webhookTimestamp: '2026-11-17T09:14:58.000Z',
      webhookKind: 'dispute_opened',
      verified: true,
      relatedEventId: 'transaction',
      request: { btSignature: 'must-not-render' },
      response: { customerEmail: 'must-not-render@example.test' },
    },
  ];
}

function routeHandler(router, method, routePath) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route was not registered`);
  return layer.route.stack.at(-1).handle;
}

function invoke(handler, request = {}) {
  return new Promise((resolve, reject) => {
    let sent = false;
    const headers = {};
    const response = {
      statusCode: 200,
      set(name, value) {
        headers[name] = value;
        return this;
      },
      status(value) {
        this.statusCode = value;
        return this;
      },
      render(view, model) {
        sent = true;
        resolve({
          status: this.statusCode,
          headers,
          view,
          model: structuredClone(model),
        });
        return this;
      },
    };

    Promise.resolve(handler(request, response, (error) => {
      reject(error || new Error('next() called without an error'));
    })).then(() => {
      if (!sent) reject(new Error('Route completed without a response'));
    }, reject);
  });
}

function sentinelRouter(label) {
  const router = express.Router();
  router.get('/', (req, res) => res.type('text/plain').send(label));
  return router;
}

test('preflight model projects discovery, routing, plan, and latest webhook evidence', () => {
  const service = catalogService();
  const model = buildPreflightViewModel({
    service,
    store: eventStore(webhookEvents()),
    environment: {},
  });

  assert.equal(service.calls.getState, 1);
  assert.equal(service.calls.refresh, 0);
  assert.equal(model.catalogStatus, 'ok');
  assert.equal(model.accountCount, 3);
  assert.equal(model.activeAccountCount, 2);
  assert.equal(model.warnings.length, 1);
  assert.deepEqual(
    model.accounts.map((account) => ({
      id: account.merchantAccountId,
      route: account.routeLabel,
      methods: account.methodLabel,
      threeDSecure: account.threeDSecureLabel,
    })),
    [
      {
        id: 'cad-main',
        route: 'One-time · Recurring',
        methods: 'Card · PayPal',
        threeDSecure: 'Required',
      },
      {
        id: 'eur-recurring',
        route: 'Recurring',
        methods: 'Card',
        threeDSecure: 'Optional',
      },
      {
        id: 'usd-inactive',
        route: 'Not assigned',
        methods: 'None enabled',
        threeDSecure: 'Not configured',
      },
    ]
  );
  assert.deepEqual(
    model.planCoverage.map(({ currency, planCount, available }) => ({
      currency,
      planCount,
      available,
    })),
    [
      { currency: 'CAD', planCount: 1, available: true },
      { currency: 'EUR', planCount: 0, available: false },
    ]
  );
  assert.equal(model.planDiscoveryLabel, 'Plan gaps found');
  assert.equal(model.webhook.state, 'unconfigured');
  assert.equal(model.latestWebhook.kindLabel, 'Dispute Opened');
  assert.equal(model.latestWebhook.receiverLabel, 'Accepted before safe persistence');
  assert.equal(model.latestWebhook.linked, true);
  assert.doesNotMatch(JSON.stringify(model.latestWebhook), /btSignature|customerEmail/);
});

test('webhook readiness never upgrades configured input into a reachability claim', () => {
  const missing = webhookConfiguration({});
  assert.equal(missing.state, 'unconfigured');
  assert.match(missing.explanation, /No WEBHOOK_PUBLIC_URL/);

  const configured = webhookConfiguration({
    WEBHOOK_PUBLIC_URL: 'https://demo-tunnel.example/api/webhooks/braintree',
  });
  assert.equal(configured.state, 'unconfirmed');
  assert.match(configured.label, /reachability unconfirmed/i);
  assert.match(configured.explanation, /does not call it or claim/i);

  const invalid = webhookConfiguration({
    WEBHOOK_PUBLIC_URL: 'http://demo-tunnel.example/api/webhooks/braintree',
  });
  assert.equal(invalid.state, 'misconfigured');
  assert.match(invalid.explanation, /Reachability was not checked/);

  const localOnly = webhookConfiguration({
    WEBHOOK_PUBLIC_URL: 'https://localhost/api/webhooks/braintree',
  });
  assert.equal(localOnly.state, 'misconfigured');
});

test('an unverified webhook relationship is not presented as linked proof', () => {
  const events = webhookEvents();
  events.at(-1).verified = false;
  const model = buildPreflightViewModel({
    service: catalogService(),
    store: eventStore(events),
    environment: {},
  });

  assert.equal(model.latestWebhook.linked, false);
  assert.equal(model.latestWebhook.linkedClass, 'is-warning');
  assert.equal(model.latestWebhook.linkedLabel, 'No verified local audit relationship');
});

test('preflight template renders safe evidence and only a read-only refresh control', async () => {
  const state = catalogState({
    warnings: [{ code: 'WARNING', message: '<img src=x onerror=alert(1)>' }],
    accounts: [
      {
        ...catalogState().accounts[0],
        label: '<script>alert(1)</script>',
      },
    ],
  });
  const model = buildPreflightViewModel({
    service: catalogService(state),
    store: eventStore(webhookEvents()),
    environment: {},
  });
  const html = await handlebars.render(
    path.join(ROOT, 'views', 'demo-preflight.hbs'),
    model
  );

  assert.match(html, /Stage 7/);
  assert.match(html, /Readiness at a glance/);
  assert.match(html, /Accounts, methods, and authentication/);
  assert.match(html, /Card 3D Secure/);
  assert.match(html, /Plan coverage/);
  assert.match(html, /Latest persisted notification/);
  assert.match(html, /Accepted before safe persistence/);
  assert.match(html, /Verified local audit relationship/);
  assert.match(html, /Reachability is never inferred/);
  assert.match(html, /action="\/demo\/preflight\/refresh" method="post"/);
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert.equal((html.match(/<input\b/g) || []).length, 0);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /must-not-render/);
  assert.doesNotMatch(html, /paymentMethodNonce|transactionId|customerId/);
});

test('default GET reads the local snapshot and makes no refresh or gateway call', async () => {
  const service = catalogService();
  const unexpectedGatewayAccess = [];
  const guardedService = new Proxy(service, {
    get(target, property, receiver) {
      if (!['getState', 'refresh', 'calls'].includes(property)) {
        unexpectedGatewayAccess.push(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const router = createDemoPreflightRouter({
    catalogService: guardedService,
    store: eventStore(webhookEvents()),
    environment: {},
  });

  const response = await invoke(routeHandler(router, 'get', '/'));
  assert.equal(response.status, 200);
  assert.equal(response.view, 'demo-preflight');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(service.calls.getState, 1);
  assert.equal(service.calls.refresh, 0);
  assert.deepEqual(unexpectedGatewayAccess, []);
});

test('explicit refresh calls only catalogService.refresh and safely renders its result', async () => {
  const service = catalogService();
  const accessed = [];
  const guardedService = new Proxy(service, {
    get(target, property, receiver) {
      accessed.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const router = createDemoPreflightRouter({
    catalogService: guardedService,
    store: eventStore(webhookEvents()),
    environment: {},
  });

  const response = await invoke(routeHandler(router, 'post', '/refresh'), { body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.view, 'demo-preflight');
  assert.equal(response.model.refreshResult.succeeded, true);
  assert.match(response.model.refreshResult.message, /without creating or changing/);
  assert.equal(service.calls.refresh, 1);
  assert.equal(service.calls.getState, 0);
  assert.deepEqual(accessed, ['refresh', 'getState']);
});

test('failed and rejected refreshes are explicit, safe 503 responses', async (t) => {
  await t.test('failed catalog state', async () => {
    const failedState = catalogState({
      status: 'failed',
      error: { message: 'Discovery unavailable.' },
      accounts: [],
      plans: [],
      planDiscovery: { status: 'not_run', discoveredAt: null, error: null },
    });
    const service = catalogService(catalogState(), failedState);
    const router = createDemoPreflightRouter({
      catalogService: service,
      store: eventStore(),
      environment: {},
    });

    const response = await invoke(routeHandler(router, 'post', '/refresh'));
    assert.equal(response.status, 503);
    assert.equal(response.model.catalogAvailable, false);
    assert.match(response.model.refreshResult.message, /No payment, customer, vault/);
  });

  await t.test('refresh exception', async () => {
    const service = catalogService();
    service.refresh = async () => {
      service.calls.refresh += 1;
      throw new Error('secret SDK diagnostic');
    };
    const router = createDemoPreflightRouter({
      catalogService: service,
      store: eventStore(),
      environment: {},
    });

    const response = await invoke(routeHandler(router, 'post', '/refresh'));
    assert.equal(response.status, 503);
    assert.equal(response.model.refreshResult.succeeded, false);
    assert.match(response.model.refreshResult.message, /failed safely/);
    assert.doesNotMatch(JSON.stringify(response.model), /secret SDK diagnostic/);
  });
});

test('preflight router is mounted before the general demo router', () => {
  const demoPreflight = sentinelRouter('preflight');
  const demo = sentinelRouter('demo');
  const app = appModule.createApp({
    requestLogger: null,
    routers: { demoPreflight, demo },
  });
  const preflightIndex = app.router.stack.findIndex(
    (layer) => layer.handle === demoPreflight
  );
  const demoIndex = app.router.stack.findIndex((layer) => layer.handle === demo);

  assert.notEqual(preflightIndex, -1);
  assert.notEqual(demoIndex, -1);
  assert.ok(preflightIndex < demoIndex);
  assert.equal(
    app.router.stack[preflightIndex].matchers[0]('/demo/preflight')?.path,
    '/demo/preflight'
  );
  assert.equal(
    app.router.stack[demoIndex].matchers[0]('/demo/preflight')?.path,
    '/demo'
  );
});

test('all demo views link to the preflight page', () => {
  for (const name of ['demo.hbs', 'demo-log.hbs', 'demo-disputes.hbs']) {
    const source = fs.readFileSync(path.join(ROOT, 'views', name), 'utf8');
    assert.match(source, /href="\/demo\/preflight"/, name);
  }
});
