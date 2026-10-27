'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const exphbs = require('express-handlebars');

const {
  buildDemoViewModel,
  createDemoRouter,
} = require('../routes/demo');

const template = exphbs.create({ extname: '.hbs' });

function account({
  id,
  currency,
  paymentTypes = [],
  sources = {},
  isDefault = false,
  assignmentState = paymentTypes.length > 0 ? 'assigned' : 'available_not_assigned',
  roleSource = paymentTypes.length > 0 ? 'auto' : null,
}) {
  return {
    key: id,
    label: `${currency} account ${id}`,
    merchantAccountId: id,
    currency,
    paymentTypes,
    paymentTypeSources: sources,
    routingReasons: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, `Test ${paymentType} policy`])
    ),
    environment: 'sandbox',
    status: 'active',
    isDefault,
    roleSource,
    assignmentState,
    purpose:
      assignmentState === 'available_not_assigned'
        ? 'Available, not assigned.'
        : 'Assigned for the test.',
  };
}

const dynamicAccounts = Object.freeze([
  account({
    id: 'cad-primary',
    currency: 'CAD',
    paymentTypes: ['one_time', 'recurring'],
    sources: { one_time: 'auto', recurring: 'auto' },
    isDefault: true,
  }),
  account({
    id: 'jpy-purchase',
    currency: 'JPY',
    paymentTypes: ['one_time'],
    sources: { one_time: 'policy' },
    roleSource: 'policy',
  }),
  account({
    id: 'jpy-billing',
    currency: 'JPY',
    paymentTypes: ['recurring'],
    sources: { recurring: 'policy' },
    roleSource: 'policy',
  }),
  account({ id: 'jpy-spare', currency: 'JPY' }),
]);

function serviceWith({
  status = 'ok',
  accounts = dynamicAccounts,
  gatewayMerchantId = 'dynamic-gateway',
  error = null,
  warnings = [{ code: 'POLICY_NOTE', message: 'Test warning.' }],
} = {}) {
  let accountReads = 0;
  const state = {
    status,
    gatewayMerchantId,
    discoveredAt: status === 'ok' ? '2026-10-15T09:30:00.000Z' : null,
    error,
    warnings,
    policyStatus: status === 'ok' ? 'applied' : 'not_loaded',
    accounts,
  };

  return {
    getState() {
      return state;
    },
    getPublicMerchantAccounts() {
      accountReads += 1;
      return accounts;
    },
    get accountReads() {
      return accountReads;
    },
  };
}

function render(model) {
  return template.render(path.join(__dirname, '..', 'views', 'demo.hbs'), model);
}

test('demo view model derives scenarios, currencies, precision, and assignments from the current catalog', () => {
  const service = serviceWith();
  const model = buildDemoViewModel(service);

  assert.equal(model.catalogAvailable, true);
  assert.equal(model.gatewayMerchantId, 'dynamic-gateway');
  assert.equal(model.accountCount, 4);
  assert.equal(model.activeAccountCount, 4);
  assert.equal(model.currencyCount, 2);
  assert.equal(model.currenciesLabel, 'CAD · JPY');
  assert.deepEqual(
    model.scenarios.map((scenario) => scenario.id),
    [
      'cad-one-time',
      'jpy-one-time',
      'jpy-recurring',
      'cad-processor-declined',
      'cad-gateway-rejected',
      'chf-no-route',
    ]
  );
  assert.deepEqual(
    model.currencyOptions.map((currency) => currency.code),
    ['CAD', 'JPY', 'CHF']
  );

  const jpy = model.currencyOptions.find((currency) => currency.code === 'JPY');
  assert.equal(jpy.step, '1');
  assert.equal(jpy.minimum, '1');
  assert.equal(jpy.maximum, '1999');
  assert.doesNotMatch(jpy.demoAmount, /\./);
  assert.match(jpy.demoRate, /^1 GBP = \d+ JPY$/);
  assert.equal(jpy.processorDeclinedAmount, '2001');
  assert.equal(jpy.gatewayRejectedAmount, '5001');

  const cad = model.currencyOptions.find((currency) => currency.code === 'CAD');
  assert.equal(cad.processorDeclinedAmount, '2001.00');
  assert.equal(cad.gatewayRejectedAmount, '5001.00');

  const spare = model.accounts.find(
    (candidate) => candidate.merchantAccountId === 'jpy-spare'
  );
  assert.equal(spare.assignmentStateLabel, 'Available · not assigned');
  assert.equal(spare.roleSourceLabel, 'None');
  assert.equal(spare.hasPaymentTypes, false);
  assert.equal(service.accountReads, 1);
});

test('demo template presents dynamic discovery metadata, demo FX labels, and raw account IDs', async () => {
  const model = buildDemoViewModel(serviceWith());
  const html = await render(model);

  for (const accountEntry of model.accounts) {
    assert.match(html, new RegExp(`<code>${accountEntry.merchantAccountId}</code>`));
  }

  assert.match(html, /Stage 2/);
  assert.match(html, /dynamic-gateway/);
  assert.match(html, /2026-10-15T09:30:00\.000Z/);
  assert.match(html, /Fixed demo rates from GBP — not live FX/);
  assert.match(html, /data-step="1"/);
  assert.match(html, /data-processor-declined-amount="2001"/);
  assert.match(html, /data-gateway-rejected-amount="5001\.00"/);
  assert.match(html, /id="transaction-mode"/);
  assert.match(html, /id="expected-outcome"/);
  assert.match(html, /href="\/demo\/log"/);
  assert.match(html, /Available · not assigned/);
  assert.match(html, /Merchant policy/);
  assert.match(html, /Refresh from gateway/);
  assert.match(html, /POLICY_NOTE/);
  assert.doesNotMatch(html, /Sandbox connected/);
  assert.doesNotMatch(html, /clientToken|paymentMethodNonce/);
});

test('failed discovery renders a safe unavailable state and never reads stale accounts', async () => {
  const service = serviceWith({
    status: 'failed',
    accounts: [account({ id: 'stale-account', currency: 'GBP', isDefault: true })],
    error: { code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED', message: 'Safe discovery failure.' },
    warnings: [],
  });
  const model = buildDemoViewModel(service);
  const html = await render(model);

  assert.equal(model.catalogAvailable, false);
  assert.equal(model.accountCount, 0);
  assert.deepEqual(model.scenarios, []);
  assert.equal(service.accountReads, 0);
  assert.match(html, /Gateway unavailable/);
  assert.match(html, /Safe discovery failure\./);
  assert.match(html, /Routing and payment controls stay disabled/);
  assert.match(html, /id="preview-route"[^>]*disabled/);
  assert.doesNotMatch(html, /stale-account/);
});

test('demo router resolves the runtime service for each request instead of capturing a startup snapshot', () => {
  const services = [
    serviceWith({ status: 'failed', gatewayMerchantId: 'first-gateway' }),
    serviceWith({ status: 'failed', gatewayMerchantId: 'second-gateway' }),
  ];
  let reads = 0;
  const router = createDemoRouter({
    getCatalogService() {
      return services[reads++];
    },
  });
  const handler = router.stack.find((layer) => layer.route?.path === '/')
    .route.stack[0].handle;
  const rendered = [];
  const response = {
    render(view, model) {
      rendered.push({ view, model });
    },
  };

  handler({}, response);
  handler({}, response);

  assert.equal(reads, 2);
  assert.equal(rendered[0].view, 'demo');
  assert.equal(rendered[0].model.gatewayMerchantId, 'first-gateway');
  assert.equal(rendered[1].model.gatewayMerchantId, 'second-gateway');
});

test('demo template escapes discovered merchant account and gateway values', async () => {
  const unsafeAccount = account({
    id: '<script>alert(1)</script>',
    currency: 'GBP',
    paymentTypes: ['one_time'],
    sources: { one_time: 'policy' },
    isDefault: true,
    roleSource: 'policy',
  });
  const model = buildDemoViewModel(
    serviceWith({
      gatewayMerchantId: '<img src=x onerror=alert(1)>',
      accounts: [unsafeAccount],
      warnings: [],
    })
  );
  const html = await render(model);

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
});

test('demo runtime source contains no Stage 1 merchant-account allowlist', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'demo.js'),
    'utf8'
  );

  for (const staticAccountId of ['paypal', 'paypal2', 'vmUSD', 'vmUSD2']) {
    assert.doesNotMatch(source, new RegExp(staticAccountId, 'i'));
  }
  assert.doesNotMatch(source, /gbp-one-time|eur-one-time|usd-one-time/i);
});
