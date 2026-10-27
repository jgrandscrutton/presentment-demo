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
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  dispatch(type) {
    this.listeners.get(type)?.({ preventDefault() {} });
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return selector === '[data-operation]' ? this.operationButtons : [];
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

function createLogClientHarness(actionOutcome) {
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

  const calls = [];
  let reloads = 0;
  async function fetch(url, options = {}) {
    calls.push({ url, method: options.method || 'GET' });
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
      querySelectorAll(selector) {
        return selector === '.transaction-log-entry[data-operable="true"]'
          ? [entry]
          : [];
      },
    },
    fetch,
    window: {
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
    controls,
    entry,
    noActions,
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
