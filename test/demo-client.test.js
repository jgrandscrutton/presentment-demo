'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(value = '') {
    this.value = value;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.className = '';
    this.href = '';
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  async dispatch(type) {
    const handler = this.listeners.get(type);
    if (handler) {
      await handler({ preventDefault() {} });
    }
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  reportValidity() {
    return true;
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function createClientHarness(paymentOutcome = 'route-mismatch', options = {}) {
  const ids = [
    'demo-payment-form',
    'scenario-id',
    'payment-type',
    'currency',
    'transaction-mode',
    'expected-outcome',
    'amount',
    'currency-prefix',
    'demo-rate',
    'sandbox-outcome-notice',
    'preview-route',
    'run-payment',
    'run-payment-label',
    'card-fields',
    'sandbox-card-hint',
    'checkout-status',
    'stage-three-notice',
    'no-route-notice',
    'inspector-state',
    'intent-summary',
    'account-summary',
    'route-reason',
    'trace-count',
    'decision-trace',
    'request-json',
    'result-details',
    'result-json',
    'verification-card',
    'verification-icon',
    'verification-title',
    'verification-copy',
    'control-panel-link',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements['scenario-id'].value = 'gbp-one-time';
  elements['payment-type'].value = 'one_time';
  elements.currency.value = 'GBP';
  elements['transaction-mode'].value = 'submit_for_settlement';
  elements['expected-outcome'].value = 'approved';
  elements.amount.value = '10.00';
  elements.currency.options = [
    {
      value: 'GBP',
      dataset: {
        symbol: '£',
        minimum: '0.01',
        maximum: '1999.99',
        step: '0.01',
        demoAmount: '10.00',
        demoRate: '1 GBP = 1 GBP',
        processorDeclinedAmount: '2001.00',
        gatewayRejectedAmount: '5001.00',
      },
    },
    {
      value: 'JPY',
      dataset: {
        symbol: '¥',
        minimum: '1',
        maximum: '1999',
        step: '1',
        demoAmount: '237',
        demoRate: '1 GBP = 191 JPY',
        processorDeclinedAmount: '2001',
        gatewayRejectedAmount: '5001',
      },
    },
  ];

  const route = {
    matched: true,
    intent: { currency: 'GBP', paymentType: 'one_time' },
    account: {
      key: 'gbp',
      label: 'UK Store – GBP',
      merchantAccountId: 'paypal2',
    },
    reason: 'GBP one-time payments use paypal2.',
    trace: [],
  };
  const safeRequest = {
    scenarioId: 'gbp-one-time',
    currency: 'GBP',
    paymentType: 'one_time',
    paymentMethod: 'card',
    transactionMode: 'submit_for_settlement',
    expectedOutcome: 'approved',
  };
  const calls = {
    preview: 0,
    token: 0,
    payment: 0,
    hostedFields: 0,
    refresh: 0,
    reload: 0,
    requests: [],
  };

  function catalogUnavailableResponse() {
    return response(503, {
      success: false,
      error: {
        code: 'CATALOG_UNAVAILABLE',
        message: 'Merchant account discovery is unavailable.',
      },
    });
  }

  async function fetch(url, request = {}) {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : null;
    calls.requests.push({ url, body });
    if (url === '/api/demo/route-preview') {
      calls.preview += 1;
      if (options.catalogUnavailableAt === 'preview') {
        return catalogUnavailableResponse();
      }
      return response(200, { success: true, request: safeRequest, route });
    }
    if (url === '/api/demo/client-token') {
      calls.token += 1;
      if (options.catalogUnavailableAt === 'token') {
        return catalogUnavailableResponse();
      }
      return response(200, {
        success: true,
        clientToken: 'test-client-authorization',
        request: safeRequest,
        route,
      });
    }
    if (url === '/api/demo/catalog/refresh') {
      calls.refresh += 1;
      if (options.refreshOutcome === 'unavailable') {
        return response(503, {
          success: false,
          error: {
            code: 'CATALOG_UNAVAILABLE',
            message: 'Fresh discovery failed; the prior catalog was discarded.',
          },
          catalog: { status: 'failed' },
        });
      }
      if (options.refreshOutcome === 'network-error') {
        throw new Error('connection closed');
      }
      return response(200, { success: true, status: 'ok' });
    }
    if (url !== '/api/demo/payments/one-time') {
      throw new Error(`Unexpected URL: ${url}`);
    }

    calls.payment += 1;
    if (options.catalogUnavailableAt === 'payment') {
      return catalogUnavailableResponse();
    }
    if (paymentOutcome === 'network-error') {
      throw new Error('connection closed');
    }
    if (paymentOutcome === 'gateway-error') {
      return response(502, {
        success: false,
        error: {
          code: 'BRAINTREE_REQUEST_FAILED',
          message: 'Braintree did not return a usable result.',
        },
        request: safeRequest,
        route,
        audit: { persisted: true },
      });
    }

    const transactionResult = {
      transaction: {
        id: 'transaction-1',
        status: paymentOutcome === 'authorized' ? 'authorized' :
          paymentOutcome === 'expected-decline' ? 'processor_declined' :
            'submitted_for_settlement',
        amount: body?.amount || '10.00',
        currencyIsoCode: 'GBP',
        merchantAccountId:
          paymentOutcome === 'route-mismatch' ? 'vmUSD' : 'paypal2',
      },
    };

    if (paymentOutcome === 'authorized') {
      return response(200, {
        success: true,
        paymentApproved: true,
        request: {
          ...safeRequest,
          transactionMode: 'authorize_only',
          amount: body?.amount,
        },
        route,
        braintreeResult: transactionResult,
        transactionStatus: 'authorized',
        demoOutcome: { expected: 'approved', actual: 'approved', matched: true },
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        audit: { persisted: true },
      });
    }

    if (paymentOutcome === 'expected-decline') {
      return response(200, {
        success: true,
        paymentApproved: false,
        request: {
          ...safeRequest,
          expectedOutcome: 'processor_declined',
          amount: body?.amount,
        },
        route,
        braintreeResult: transactionResult,
        transactionStatus: 'processor_declined',
        demoOutcome: {
          expected: 'processor_declined',
          actual: 'processor_declined',
          matched: true,
        },
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        audit: { persisted: true },
      });
    }

    if (paymentOutcome === 'audit-warning') {
      return response(200, {
        success: true,
        request: safeRequest,
        route,
        braintreeResult: transactionResult,
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        audit: {
          persisted: false,
          warning: 'The transaction completed, but its audit event was not saved. Do not retry.',
        },
      });
    }

    return response(502, {
      success: false,
      error: {
        code: 'ROUTE_VERIFICATION_FAILED',
        message: 'A transaction was returned on another account. Do not retry.',
      },
      request: safeRequest,
      route,
      braintreeResult: transactionResult,
      verification: {
        passed: false,
        explanation: 'Expected paypal2 but Braintree returned vmUSD.',
      },
      audit: { persisted: true },
      controlPanelUrl:
        'https://sandbox.braintreegateway.com/merchants/test/transactions/transaction-1',
    });
  }

  const refreshButton = new FakeElement();
  const refreshStatus = new FakeElement();
  const staleCatalogContent = [new FakeElement(), new FakeElement()];
  const document = {
    body: {
      dataset: {
        catalogAvailable: options.catalogAvailable === false ? 'false' : 'true',
      },
    },
    querySelector(selector) {
      return elements[selector.slice(1)] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-catalog-refresh]') return [refreshButton];
      if (selector === '[data-refresh-status]') return [refreshStatus];
      if (selector === '[data-catalog-stale-content]') return staleCatalogContent;
      return [];
    },
    createElement() {
      return new FakeElement();
    },
  };
  const window = {
    location: {
      reload() {
        calls.reload += 1;
      },
    },
    braintree: {
      client: {
        async create() {
          return {};
        },
      },
      hostedFields: {
        async create() {
          calls.hostedFields += 1;
          return {
            async tokenize() {
              return { nonce: 'test-payment-method-reference' };
            },
            async teardown() {},
          };
        },
      },
    },
  };

  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'scripts', 'demo.js'),
    'utf8'
  );
  vm.runInNewContext(script, { document, window, fetch, console });

  return {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for the demo client state');
}

test('route mismatch blocks implicit resubmission until Hosted Fields is rebuilt by a fresh preview', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.payment, 1);
  assert.equal(elements['run-payment'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /Do not retry/i);

  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.payment, 1);
  assert.match(elements['checkout-status'].textContent, /fresh route preview/i);

  await elements['preview-route'].dispatch('click');
  assert.equal(calls.hostedFields, 2);
  assert.equal(elements['run-payment'].disabled, false);
});

test('ambiguous or unaudited payment outcomes require a fresh preview before resubmission', async (t) => {
  for (const outcome of ['gateway-error', 'network-error', 'audit-warning']) {
    await t.test(outcome, async () => {
      const { calls, elements } = createClientHarness(outcome);
      await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

      await elements['demo-payment-form'].dispatch('submit');
      assert.equal(calls.payment, 1);
      assert.equal(elements['run-payment'].disabled, true);
      assert.match(elements['checkout-status'].textContent, /Do not retry/i);

      await elements['demo-payment-form'].dispatch('submit');
      assert.equal(calls.payment, 1);
    });
  }
});

test('currency changes apply discovered precision, range, symbol, and fixed demo amount', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1);

  elements.currency.value = 'JPY';
  await elements.currency.dispatch('change');

  assert.equal(elements.amount.min, '1');
  assert.equal(elements.amount.max, '1999');
  assert.equal(elements.amount.step, '1');
  assert.equal(elements.amount.value, '237');
  assert.equal(elements['currency-prefix'].textContent, '¥');
  assert.equal(elements['demo-rate'].textContent, '1 GBP = 191 JPY');
  assert.equal(elements.amount.attributes.get('inputmode'), 'numeric');
  assert.equal(calls.preview, 2);
});

test('sandbox failure choices lock the exact per-currency trigger amount and are labelled as non-FX', async () => {
  const { calls, elements } = createClientHarness('expected-decline');
  await waitFor(() => calls.hostedFields === 1);

  elements['expected-outcome'].value = 'processor_declined';
  await elements['expected-outcome'].dispatch('change');

  assert.equal(elements.amount.value, '2001.00');
  assert.equal(elements.amount.min, '2001.00');
  assert.equal(elements.amount.max, '2001.00');
  assert.equal(elements.amount.readOnly, true);
  assert.equal(elements['sandbox-outcome-notice'].hidden, false);
  assert.match(elements['demo-rate'].textContent, /Sandbox trigger · not demo FX/);
  assert.match(elements['run-payment-label'].textContent, /processor decline/i);

  elements.currency.value = 'JPY';
  await elements.currency.dispatch('change');
  assert.equal(elements.amount.value, '2001');
  assert.equal(elements.amount.step, '1');

  elements.currency.value = 'GBP';
  await elements.currency.dispatch('change');
  await elements['demo-payment-form'].dispatch('submit');

  const paymentRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(paymentRequest.body.expectedOutcome, 'processor_declined');
  assert.equal(paymentRequest.body.amount, '2001.00');
  assert.match(elements['checkout-status'].textContent, /observed as expected/i);
  assert.match(elements['checkout-status'].textContent, /No payment was approved/i);

  elements['expected-outcome'].value = 'approved';
  await elements['expected-outcome'].dispatch('change');
  assert.equal(elements.amount.value, '10.00');
  assert.equal(elements.amount.readOnly, false);
  assert.equal(elements['sandbox-outcome-notice'].hidden, true);
  assert.equal(elements['demo-rate'].textContent, '1 GBP = 1 GBP');
});

test('authorize-only is included in request state and reports an authorization distinctly', async () => {
  const { calls, elements } = createClientHarness('authorized');
  await waitFor(() => calls.hostedFields === 1);

  elements['transaction-mode'].value = 'authorize_only';
  await elements['transaction-mode'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  assert.match(elements['run-payment-label'].textContent, /Authorize sandbox/i);

  await elements['demo-payment-form'].dispatch('submit');
  const paymentRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(paymentRequest.body.transactionMode, 'authorize_only');
  assert.equal(elements['inspector-state'].textContent, 'Authorized');
  assert.match(elements['checkout-status'].textContent, /authorization created/i);
});

test('an unavailable catalog at page load disables the runner without making an automatic API call', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    catalogAvailable: false,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.preview, 0);
  assert.equal(calls.token, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['payment-type'].disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /Gateway unavailable/i);
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
});

test('a CATALOG_UNAVAILABLE preview response fails closed before token setup', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    catalogUnavailableAt: 'preview',
  });

  await waitFor(() => elements['inspector-state'].textContent === 'Unavailable');

  assert.equal(calls.preview, 1);
  assert.equal(calls.token, 0);
  assert.equal(calls.hostedFields, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /discovery is unavailable/i);
});

test('catalog refresh posts to the discovery endpoint and reloads after success', async () => {
  const { calls, refreshButton, refreshStatus } = createClientHarness(
    'route-mismatch',
    { catalogAvailable: false }
  );

  await refreshButton.dispatch('click');

  assert.equal(calls.refresh, 1);
  assert.equal(calls.reload, 1);
  assert.match(refreshStatus.textContent, /Reloading/i);
  assert.equal(refreshButton.disabled, false);
});

test('a failed catalog refresh immediately invalidates stale routing and catalog UI', async () => {
  const {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
  } = createClientHarness(
    'route-mismatch',
    { refreshOutcome: 'unavailable' }
  );
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);
  assert.match(elements['account-summary'].textContent, /paypal2/);

  await refreshButton.dispatch('click');

  assert.equal(calls.refresh, 1);
  assert.equal(calls.reload, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['payment-type'].disabled, true);
  assert.equal(elements.amount.disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.equal(elements['account-summary'].textContent, 'No catalog');
  assert.equal(elements['intent-summary'].textContent, '—');
  assert.equal(elements['request-json'].textContent, '{}');
  assert.equal(elements['trace-count'].textContent, '0 checks');
  assert.equal(elements['result-json'].textContent, 'No transaction has been sent.');
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
  assert.ok(staleCatalogContent.every((element) => element.hidden));
  assert.match(elements['checkout-status'].textContent, /prior catalog was discarded/i);
  assert.match(refreshStatus.textContent, /prior catalog was discarded/i);
  assert.equal(refreshButton.disabled, false);
});

test('a refresh network failure also invalidates the current catalog presentation', async () => {
  const {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
  } = createClientHarness(
    'route-mismatch',
    { refreshOutcome: 'network-error' }
  );
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

  await refreshButton.dispatch('click');

  assert.equal(calls.reload, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.equal(elements['account-summary'].textContent, 'No catalog');
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
  assert.ok(staleCatalogContent.every((element) => element.hidden));
  assert.match(elements['checkout-status'].textContent, /could not be completed/i);
  assert.match(refreshStatus.textContent, /could not be completed/i);
});
