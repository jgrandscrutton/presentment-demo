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
  paymentMethods = ['card'],
  threeDSecurePolicy = 'optional',
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
    paymentMethods,
    threeDSecurePolicy,
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
    paymentMethods: ['card', 'paypal'],
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
  plans = [
    {
      id: 'cad-monthly',
      name: 'CAD Monthly',
      description: 'Monthly sandbox plan',
      currency: 'CAD',
      price: '21.36',
      billingFrequency: 1,
      internalOnly: 'must-not-leak',
    },
  ],
  planDiscovery = {
    status: 'ok',
    discoveredAt: '2026-10-15T09:30:00.000Z',
    error: null,
  },
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
    plans,
    planDiscovery,
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
      'cad-recurring',
      'jpy-one-time',
      'jpy-recurring',
      'cad-processor-declined',
      'cad-gateway-rejected',
      'cad-dispute',
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

  assert.deepEqual(model.planOptions, [
    {
      id: 'cad-monthly',
      name: 'CAD Monthly',
      description: 'Monthly sandbox plan',
      currency: 'CAD',
      price: '21.36',
      billingFrequency: 1,
      label: 'CAD Monthly · 21.36 CAD · every 1 month',
    },
  ]);
  assert.deepEqual(model.planAvailability, [
    {
      currency: 'CAD',
      available: true,
      planCount: 1,
      message: '1 plan available',
    },
    {
      currency: 'JPY',
      available: false,
      planCount: 0,
      message: 'No plan available',
    },
  ]);
  assert.equal(model.initialPlanId, 'cad-monthly');
  assert.equal(model.planDiscoveryStatus, 'ok');
  assert.equal(model.planDiscoveryMessage, 'Plans loaded from Braintree Sandbox.');
  assert.equal(Object.hasOwn(model.planOptions[0], 'internalOnly'), false);

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

  assert.match(html, /Server-selected routing · Braintree Sandbox/);
  assert.match(html, /id="payment-method-chooser"/);
  assert.match(html, /name="paymentMethod" value="card"/);
  assert.match(html, /name="paymentMethod" value="paypal"/);
  assert.match(html, /id="paypal-button"/);
  assert.match(html, /payment-method-paypal">PayPal</);
  assert.match(html, /paypal-checkout\.min\.js/);
  assert.match(html, /three-d-secure\.min\.js/);
  assert.match(html, /id="three-d-secure-panel"/);
  assert.match(html, /4000 0000 0000 2701/);
  assert.match(html, /id="three-d-secure-proof"/);
  assert.match(html, /id="three-d-secure-scope-proof"/);
  assert.match(html, /Card 3DS policy/);
  assert.match(html, /dynamic-gateway/);
  assert.match(html, /2026-10-15T09:30:00\.000Z/);
  assert.match(html, /Fixed demo rates from GBP — not live FX/);
  assert.match(html, /data-step="1"/);
  assert.match(html, /data-processor-declined-amount="2001"/);
  assert.match(html, /data-gateway-rejected-amount="5001\.00"/);
  assert.match(html, /data-dispute-scenario="true"/);
  assert.match(html, /4023 8984 9398 8028/);
  assert.match(html, /id="transaction-mode"/);
  assert.match(html, /id="expected-outcome"/);
  assert.match(html, /id="recurring-model"/);
  assert.match(html, /value="merchant_managed"/);
  assert.match(html, /value="braintree_subscription"/);
  assert.match(html, /id="plan-id"/);
  assert.match(html, /value="cad-monthly" data-currency="CAD"/);
  assert.match(html, /No plan available/);
  assert.match(html, /Braintree controls the billing schedule/);
  assert.match(html, /run the next cycle immediately/);
  assert.match(html, /id="run-next-cycle"/);
  assert.match(html, /id="run-vault-one-time"/);
  assert.match(html, /id="refresh-subscription"/);
  assert.match(html, /id="cancel-subscription"/);
  assert.match(html, /href="\/demo\/log"/);
  assert.match(html, /Available · not assigned/);
  assert.match(html, /Merchant policy/);
  assert.match(html, /Refresh discovery/);
  assert.match(html, /POLICY_NOTE/);
  assert.doesNotMatch(html, /Sandbox connected/);
  assert.doesNotMatch(html, /clientToken|paymentMethodNonce/);
  assert.doesNotMatch(html, /Preview only/);
  assert.doesNotMatch(html, /must-not-leak/);
});

test('demo template keeps the routing workflow focused and keyboard discoverable', async () => {
  const html = await render(buildDemoViewModel(serviceWith()));

  assert.match(html, /<body class="routing-demo"/);
  assert.match(
    html,
    /<body[^>]*>\s*<a class="skip-link" href="#runner">Skip to scenario runner<\/a>/
  );
  assert.match(html, /<h1 id="page-title">Route payments with clear proof\.<\/h1>/);
  assert.match(html, /<h2 id="runner-title">Route a payment<\/h2>/);
  assert.match(html, /<h3>Start with a preset<\/h3>/);
  assert.match(html, /aria-current="page"[^>]*>Demo<\/a>/);
  assert.match(html, /<h2 id="registry-title">Discovered accounts<\/h2>/);

  assert.doesNotMatch(html, /class="proof-strip"/);
  assert.doesNotMatch(html, /class="review-gate"/);
});

test('routing demo stylesheet exposes clean, accessible interaction contracts', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'stylesheets', 'demo.css'),
    'utf8'
  );

  assert.match(css, /--color-primary:\s*#3b82f6;/);
  assert.match(css, /--color-success:\s*#16a34a;/);
  assert.match(css, /--color-danger:\s*#dc2626;/);
  assert.match(css, /--space-1:\s*8px;/);
  assert.match(css, /--font-primary:/);
  assert.match(css, /--focus-ring:\s*#2563eb;/);
  assert.match(css, /\.skip-link:focus(?:-visible)?\s*\{/);
  assert.match(
    css,
    /\.routing-demo[\s\S]*?outline:\s*3px solid var\(--focus-ring\);/
  );
  assert.match(
    css,
    /\.routing-demo[\s\S]*?min-height:\s*(?:44|48)px;/
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?scroll-behavior:\s*auto;/
  );
});

test('plan discovery failure keeps Model A available and exposes only a safe message', () => {
  const model = buildDemoViewModel(serviceWith({
    plans: [],
    planDiscovery: {
      status: 'failed',
      discoveredAt: null,
      error: {
        code: 'PLAN_DISCOVERY_FAILED',
        message: 'Subscription plans could not be loaded.',
        privateDetails: 'do not expose',
      },
    },
  }));

  assert.equal(model.catalogAvailable, true);
  assert.equal(model.hasPlans, false);
  assert.equal(model.planDiscoveryStatus, 'failed');
  assert.equal(
    model.planDiscoveryMessage,
    'Subscription plans could not be loaded.'
  );
  assert.ok(model.scenarios.some((scenario) => scenario.paymentType === 'recurring'));
  assert.doesNotMatch(JSON.stringify(model), /do not expose/);
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
