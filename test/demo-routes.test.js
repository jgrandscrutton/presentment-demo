'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const exphbs = require('express-handlebars');

const appModule = require('../app');
const {
  RESTORE_CONFIRMATION,
  assignmentsFromRequest,
  buildRouteMappingViewModel,
  createDemoRoutesRouter,
} = require('../routes/demo-routes');

const ROOT = path.join(__dirname, '..');

function account(id, currency, paymentTypes, options = {}) {
  return {
    key: id,
    merchantAccountId: id,
    label: options.label || `${currency} ${id}`,
    currency,
    status: options.status || 'active',
    isDefault: options.isDefault === true,
    paymentTypes,
    paymentMethods: options.status === 'suspended' ? [] : ['card', 'paypal'],
    threeDSecurePolicy: options.policy || 'optional',
  };
}

function catalogFixture() {
  const state = {
    status: 'ok',
    gatewayMerchantId: 'gateway-current',
    discoveredAt: '2026-11-17T10:00:00.000Z',
    policyStatus: 'applied',
    error: null,
    accounts: [
      account('gbp-default', 'GBP', ['one_time', 'recurring'], {
        isDefault: true,
      }),
      account('usd-sales', 'USD', ['one_time']),
      account('usd-billing', 'USD', ['recurring']),
      account('usd-suspended', 'USD', [], { status: 'suspended' }),
    ],
  };
  let refreshCount = 0;
  return {
    get refreshCount() {
      return refreshCount;
    },
    getState() {
      return structuredClone(state);
    },
    async refresh() {
      refreshCount += 1;
      return structuredClone(state);
    },
  };
}

function writerFixture() {
  let baselineAvailable = false;
  const calls = { save: [], restore: [], hasBaseline: [] };
  return {
    calls,
    async hasBaseline(args) {
      calls.hasBaseline.push(structuredClone(args));
      return baselineAvailable;
    },
    async save(args) {
      calls.save.push({
        merchantId: args.merchantId,
        accounts: structuredClone(args.accounts),
        assignments: structuredClone(args.assignments),
      });
      baselineAvailable = true;
      await args.refresh();
    },
    async restore(args) {
      calls.restore.push({ merchantId: args.merchantId });
      await args.refresh();
    },
  };
}

async function startRouter(t, router) {
  const app = express();
  app.set('views', path.join(ROOT, 'views'));
  app.engine('hbs', exphbs.engine({ extname: '.hbs' }));
  app.set('view engine', 'hbs');
  app.use(express.urlencoded({ extended: false }));
  app.use('/demo/routes', router);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).type('text/plain').send(error.message);
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The route-editor test server could not bind a loopback port.');
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${address.port}`;
}

function sessionCookie(response, fallback = '') {
  const setCookie = response.headers.get('set-cookie');
  return setCookie ? setCookie.split(';', 1)[0] : fallback;
}

function hiddenCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'the response should contain a CSRF token');
  return match[1];
}

async function postForm(baseUrl, routePath, form, cookie = '') {
  return fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
    body: new URLSearchParams(form),
  });
}

async function authenticate(baseUrl, passcode) {
  const loginPage = await fetch(`${baseUrl}/demo/routes`, { redirect: 'manual' });
  const loginHtml = await loginPage.text();
  const loginCookie = sessionCookie(loginPage);
  const response = await postForm(
    baseUrl,
    '/demo/routes/login',
    { _csrf: hiddenCsrf(loginHtml), passcode },
    loginCookie
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/demo/routes');
  return sessionCookie(response, loginCookie);
}

test('route mapping model exposes active same-currency choices and read-only facts', () => {
  const state = catalogFixture().getState();
  state.accounts[1].label = '<script>not markup</script>';
  const model = buildRouteMappingViewModel(state);

  assert.deepEqual(model.routeGroups.map((group) => group.currency), ['GBP', 'USD']);
  const usd = model.routeGroups.find((group) => group.currency === 'USD');
  assert.deepEqual(
    usd.routes[0].options.map((option) => option.merchantAccountId),
    ['usd-billing', 'usd-sales']
  );
  assert.equal(
    usd.routes[0].options.some((option) => option.merchantAccountId === 'gbp-default'),
    false
  );
  assert.equal(
    usd.routes[0].options.some((option) => option.merchantAccountId === 'usd-suspended'),
    false
  );
  assert.equal(usd.routes[0].currentAccountId, 'usd-sales');
  assert.equal(model.accounts[1].label, '<script>not markup</script>');
});

test('submitted assignments are derived only from current catalog routes', () => {
  const state = catalogFixture().getState();
  const result = assignmentsFromRequest(state, {
    route_GBP_one_time: 'gbp-default',
    route_GBP_recurring: 'gbp-default',
    route_USD_one_time: 'usd-billing',
    route_USD_recurring: 'usd-sales',
    merchantId: 'browser-controlled',
    privateKey: 'must-be-ignored',
    route_EUR_one_time: 'unknown',
  });

  assert.deepEqual(result.assignments, [
    { currency: 'GBP', paymentType: 'one_time', merchantAccountId: 'gbp-default' },
    { currency: 'GBP', paymentType: 'recurring', merchantAccountId: 'gbp-default' },
    { currency: 'USD', paymentType: 'one_time', merchantAccountId: 'usd-billing' },
    { currency: 'USD', paymentType: 'recurring', merchantAccountId: 'usd-sales' },
  ]);
});

test('route mapping fails closed when no presenter passcode is configured', async (t) => {
  const router = createDemoRoutesRouter({
    catalogService: catalogFixture(),
    policyWriter: writerFixture(),
    presenterPasscode: '',
    sessionSecret: 'test-session-secret',
  });
  const baseUrl = await startRouter(t, router);
  const response = await fetch(`${baseUrl}/demo/routes`);
  const html = await response.text();

  assert.equal(response.status, 503);
  assert.match(html, /Route mapping is disabled/);
  assert.match(html, /DEMO_PRESENTER_PASSCODE/);
  assert.doesNotMatch(html, /name="passcode"/);
});

test('protected editor uses an HttpOnly strict cookie and never echoes the passcode', async (t) => {
  const passcode = 'presenter-secret-value';
  const router = createDemoRoutesRouter({
    catalogService: catalogFixture(),
    policyWriter: writerFixture(),
    presenterPasscode: passcode,
    sessionSecret: 'test-session-secret',
  });
  const baseUrl = await startRouter(t, router);

  const loginPage = await fetch(`${baseUrl}/demo/routes`);
  const loginHtml = await loginPage.text();
  const initialSetCookie = loginPage.headers.get('set-cookie');
  assert.match(initialSetCookie, /HttpOnly/i);
  assert.match(initialSetCookie, /SameSite=Strict/i);
  assert.match(initialSetCookie, /Path=\/demo\/routes/i);
  assert.doesNotMatch(loginHtml, new RegExp(passcode));

  const wrong = await postForm(
    baseUrl,
    '/demo/routes/login',
    { _csrf: hiddenCsrf(loginHtml), passcode: 'wrong' },
    sessionCookie(loginPage)
  );
  const wrongHtml = await wrong.text();
  assert.equal(wrong.status, 401);
  assert.match(wrongHtml, /not accepted/);
  assert.doesNotMatch(wrongHtml, new RegExp(passcode));

  const cookie = await authenticate(baseUrl, passcode);
  const editor = await fetch(`${baseUrl}/demo/routes`, {
    headers: { cookie },
  });
  const editorHtml = await editor.text();
  assert.equal(editor.status, 200);
  assert.match(editorHtml, /Validate and save routes/);
  assert.match(editorHtml, /gateway-current/);
  assert.doesNotMatch(editorHtml, new RegExp(passcode));
  assert.equal(editor.headers.get('cache-control'), 'no-store');
  assert.match(editor.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('save requires authentication and CSRF, then passes only server-owned catalog authority', async (t) => {
  const service = catalogFixture();
  const writer = writerFixture();
  const router = createDemoRoutesRouter({
    catalogService: service,
    policyWriter: writer,
    presenterPasscode: 'correct-passcode',
    sessionSecret: 'test-session-secret',
  });
  const baseUrl = await startRouter(t, router);

  const unauthorized = await postForm(baseUrl, '/demo/routes/save', {});
  assert.equal(unauthorized.status, 401);
  assert.equal(writer.calls.save.length, 0);

  const cookie = await authenticate(baseUrl, 'correct-passcode');
  const editor = await fetch(`${baseUrl}/demo/routes`, { headers: { cookie } });
  const editorHtml = await editor.text();
  const csrf = hiddenCsrf(editorHtml);

  const rejected = await postForm(
    baseUrl,
    '/demo/routes/save',
    { _csrf: 'wrong-token' },
    cookie
  );
  assert.equal(rejected.status, 403);
  assert.equal(writer.calls.save.length, 0);

  const saved = await postForm(
    baseUrl,
    '/demo/routes/save',
    {
      _csrf: csrf,
      route_GBP_one_time: 'gbp-default',
      route_GBP_recurring: 'gbp-default',
      route_USD_one_time: 'usd-billing',
      route_USD_recurring: 'usd-sales',
      merchantId: 'attacker-merchant',
      privateKey: 'attacker-secret',
    },
    cookie
  );
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/demo/routes?notice=saved');
  assert.equal(writer.calls.save.length, 1);
  assert.equal(writer.calls.save[0].merchantId, 'gateway-current');
  assert.deepEqual(
    writer.calls.save[0].assignments.filter((item) => item.currency === 'USD'),
    [
      { currency: 'USD', paymentType: 'one_time', merchantAccountId: 'usd-billing' },
      { currency: 'USD', paymentType: 'recurring', merchantAccountId: 'usd-sales' },
    ]
  );
  assert.equal(
    Object.hasOwn(writer.calls.save[0], 'privateKey'),
    false
  );
  assert.equal(service.refreshCount, 1);
});

test('restore requires explicit confirmation and refreshes the server-owned merchant policy', async (t) => {
  const service = catalogFixture();
  const writer = writerFixture();
  const router = createDemoRoutesRouter({
    catalogService: service,
    policyWriter: writer,
    presenterPasscode: 'correct-passcode',
    sessionSecret: 'test-session-secret',
  });
  const baseUrl = await startRouter(t, router);
  const cookie = await authenticate(baseUrl, 'correct-passcode');
  const editor = await fetch(`${baseUrl}/demo/routes`, { headers: { cookie } });
  const csrf = hiddenCsrf(await editor.text());

  const unconfirmed = await postForm(
    baseUrl,
    '/demo/routes/restore',
    { _csrf: csrf },
    cookie
  );
  assert.equal(unconfirmed.status, 400);
  assert.equal(writer.calls.restore.length, 0);

  const restored = await postForm(
    baseUrl,
    '/demo/routes/restore',
    { _csrf: csrf, confirmRestore: RESTORE_CONFIRMATION },
    cookie
  );
  assert.equal(restored.status, 303);
  assert.equal(restored.headers.get('location'), '/demo/routes?notice=restored');
  assert.deepEqual(writer.calls.restore, [{ merchantId: 'gateway-current' }]);
  assert.equal(service.refreshCount, 1);
});

test('route mapping router is mounted before the general demo router', () => {
  const demoRoutes = express.Router();
  const demo = express.Router();
  const app = appModule.createApp({
    requestLogger: null,
    routers: { demoRoutes, demo },
  });
  const routeIndex = app.router.stack.findIndex((layer) => layer.handle === demoRoutes);
  const demoIndex = app.router.stack.findIndex((layer) => layer.handle === demo);
  assert.notEqual(routeIndex, -1);
  assert.notEqual(demoIndex, -1);
  assert.ok(routeIndex < demoIndex);
  assert.equal(app.router.stack[routeIndex].matchers[0]('/demo/routes')?.path, '/demo/routes');
});

test('every demo navigation includes protected route mapping', () => {
  for (const filename of [
    'demo.hbs',
    'demo-log.hbs',
    'demo-disputes.hbs',
    'demo-preflight.hbs',
    'demo-routes.hbs',
  ]) {
    const contents = require('node:fs').readFileSync(
      path.join(ROOT, 'views', filename),
      'utf8'
    );
    assert.match(contents, /href="\/demo\/routes"/, filename);
  }
});
