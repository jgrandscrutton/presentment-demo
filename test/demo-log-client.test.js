'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor() {
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.placeholder = '';
    this.textContent = '';
    this.value = '';
    this.listeners = new Map();
    this.selectors = new Map();
    this.operationButtons = [];
    this.attributes = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  dispatch(type) {
    return this.listeners.get(type)?.({ preventDefault() {} });
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return selector === '[data-operation]' ? this.operationButtons : [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {}
}

function response(status, payload, { readable = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (!readable) throw new SyntaxError('unreadable response');
      return structuredClone(payload);
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createLogClientHarness(actionOutcome, { confirmReset = true } = {}) {
  const entry = new FakeElement();
  entry.dataset.eventId = 'event-123';
  entry.dataset.operable = 'true';

  const status = new FakeElement();
  const controls = new FakeElement();
  controls.hidden = true;
  const noActions = new FakeElement();
  noActions.hidden = true;
  const button = new FakeElement();
  button.dataset.operation = 'void';
  entry.operationButtons = [button];

  entry.selectors.set('[data-live-status]', status);
  entry.selectors.set('[data-action-controls]', controls);
  entry.selectors.set('[data-no-actions]', noActions);
  for (const action of ['capture', 'void', 'settle', 'refund']) {
    const group = new FakeElement();
    group.hidden = true;
    entry.selectors.set(`[data-action-group="${action}"]`, group);
    entry.selectors.set(`[data-action-amount="${action}"]`, new FakeElement());
    entry.selectors.set(`[data-maximum-copy="${action}"]`, new FakeElement());
  }

  const resetPanel = new FakeElement();
  const resetButton = new FakeElement();
  resetButton.dataset.resetEndpoint = '/demo/log/reset';
  resetButton.dataset.resetConfirmation = 'clear-local-demo-events';
  const resetStatus = new FakeElement();

  const calls = [];
  const confirmations = [];
  let reloads = 0;
  async function fetch(url, options = {}) {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: structuredClone(options.headers || {}),
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
    });
    if (url.endsWith('/status')) {
      return response(200, {
        success: true,
        transaction: {
          id: 'txn-123',
          status: 'authorized',
          currencyIsoCode: 'CAD',
        },
        actions: {
          capture: { allowed: true, maximumAmount: '10.00' },
          void: { allowed: true },
          settle: { allowed: false },
          refund: { allowed: false },
        },
      });
    }

    if (url === '/demo/log/reset') {
      if (actionOutcome === 'reset-success') {
        return response(200, {
          success: true,
          clearedLocalEvents: 4,
          braintreeObjectsChanged: false,
        });
      }
      if (actionOutcome === 'reset-unreadable') {
        return response(200, null, { readable: false });
      }
      if (actionOutcome === 'reset-error') {
        return response(500, {
          success: false,
          error: {
            message: 'Local demo history could not be cleared. Nothing in Braintree was changed.',
          },
        });
      }
      throw new Error('reset connection closed');
    }

    if (actionOutcome === 'transport-error') {
      throw new Error('connection closed');
    }
    if (actionOutcome === 'unreadable') {
      return response(200, null, { readable: false });
    }
    if (actionOutcome === 'retry-unsafe') {
      return response(502, {
        success: false,
        retrySafe: false,
        error: { message: 'The action outcome is unknown. Do not retry.' },
      });
    }
    if (actionOutcome === 'retry-safe') {
      return response(400, {
        success: false,
        retrySafe: true,
        error: { message: 'Choose a valid amount and try again.' },
      });
    }
    throw new Error(`Unexpected action outcome ${actionOutcome}`);
  }

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'scripts', 'demo-log.js'),
    'utf8'
  );
  vm.runInNewContext(source, {
    document: {
      querySelector(selector) {
        if (selector === '[data-local-reset]') return resetPanel;
        if (selector === '[data-local-reset-button]') return resetButton;
        if (selector === '#local-reset-status') return resetStatus;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '.transaction-log-entry[data-operable="true"]'
          ? [entry]
          : [];
      },
    },
    fetch,
    window: {
      confirm(message) {
        confirmations.push(message);
        return confirmReset;
      },
      location: {
        reload() {
          reloads += 1;
        },
      },
    },
    console,
    encodeURIComponent,
    JSON,
  });

  return {
    button,
    calls,
    confirmations,
    controls,
    entry,
    noActions,
    resetButton,
    resetPanel,
    resetStatus,
    status,
    get reloads() {
      return reloads;
    },
    async open() {
      entry.open = true;
      entry.dispatch('toggle');
      await tick();
      await tick();
    },
    async act() {
      button.dispatch('click');
      await tick();
      await tick();
    },
    async reset() {
      resetButton.dispatch('click');
      await tick();
      await tick();
    },
  };
}

test('log loads live Braintree state lazily when an operable row is expanded', async () => {
  const harness = createLogClientHarness('retry-safe');

  assert.equal(harness.calls.length, 0);
  assert.equal(harness.button.disabled, true);
  await harness.open();

  assert.equal(harness.calls.length, 1);
  assert.match(harness.calls[0].url, /event-123\/status$/);
  assert.equal(harness.controls.hidden, false);
  assert.equal(harness.button.disabled, false);
  assert.match(harness.status.textContent, /authorized.*2 actions available/);
});

for (const outcome of ['transport-error', 'unreadable', 'retry-unsafe']) {
  test(`${outcome} after an action request keeps every lifecycle control locked`, async () => {
    const harness = createLogClientHarness(outcome);
    await harness.open();
    await harness.act();

    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].method, 'POST');
    assert.equal(harness.controls.hidden, true);
    assert.equal(harness.button.disabled, true);
    assert.match(harness.status.textContent, /do not retry/i);
    assert.equal(harness.reloads, 0);
  });
}

test('an explicitly retry-safe action validation failure re-enables the controls', async () => {
  const harness = createLogClientHarness('retry-safe');
  await harness.open();
  await harness.act();

  assert.equal(harness.controls.hidden, false);
  assert.equal(harness.button.disabled, false);
  assert.match(harness.status.textContent, /valid amount/i);
  assert.equal(harness.reloads, 0);
});

test('local reset cancellation names the boundary and makes no request', async () => {
  const harness = createLogClientHarness('reset-success', { confirmReset: false });

  await harness.reset();

  assert.equal(harness.calls.length, 0);
  assert.equal(harness.reloads, 0);
  assert.equal(harness.resetButton.disabled, false);
  assert.equal(harness.confirmations.length, 1);
  assert.match(
    harness.confirmations[0],
    /transactions, subscriptions, customers, payment methods, or disputes/i
  );
  assert.match(harness.resetStatus.textContent, /cancelled.*nothing changed/i);
});

test('confirmed local reset sends the exact guarded JSON request and reloads on success', async () => {
  const harness = createLogClientHarness('reset-success');

  await harness.reset();

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0], {
    url: '/demo/log/reset',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Reset-Confirmation': 'clear-local-demo-events',
    },
    body: { scope: 'local_event_store' },
  });
  assert.equal(harness.reloads, 1);
  assert.equal(harness.resetButton.disabled, true);
  assert.equal(harness.resetPanel.attributes.has('aria-busy'), false);
  assert.equal(harness.resetStatus.dataset.state, 'success');
  assert.match(harness.resetStatus.textContent, /4 local events cleared/i);
  assert.match(harness.resetStatus.textContent, /Braintree objects are unchanged/i);
});

for (const outcome of ['reset-error', 'reset-unreadable', 'reset-transport']) {
  test(`${outcome} keeps the local reset retryable and never reloads`, async () => {
    const harness = createLogClientHarness(outcome);

    await harness.reset();

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.reloads, 0);
    assert.equal(harness.resetButton.disabled, false);
    assert.equal(harness.resetPanel.attributes.has('aria-busy'), false);
    assert.equal(harness.resetStatus.dataset.state, 'error');
    assert.match(harness.resetStatus.textContent, /Nothing in Braintree was changed/i);
  });
}
