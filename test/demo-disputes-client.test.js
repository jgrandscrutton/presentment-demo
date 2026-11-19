'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.id = '';
    this.textContent = '';
    this.value = '';
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  dispatch(type) {
    if (type === 'click' && this.disabled) return undefined;
    return this.listeners.get(type)?.({ preventDefault() {} });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === 'textarea') return this.tagName === 'TEXTAREA';
    const dataMatch = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (!dataMatch) return false;
    const key = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!Object.hasOwn(this.dataset, key)) return false;
    return dataMatch[2] === undefined || this.dataset[key] === dataMatch[2];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((entry) => entry.trim());
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (selectors.some((candidate) => child.matches(candidate))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class FakeTextAreaElement extends FakeElement {}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.elements = new Map();
  }

  register(id, tagName = 'div') {
    const element = this.createElement(tagName);
    element.id = id;
    this.elements.set(id, element);
    return element;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  createElement(tagName) {
    return String(tagName).toLowerCase() === 'textarea'
      ? new FakeTextAreaElement(tagName, this)
      : new FakeElement(tagName, this);
  }
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
  };
}

function disputeRow(overrides = {}) {
  return {
    eventId: 'webhook-event-1',
    receivedAt: '2026-11-02T12:00:00.000Z',
    webhookKind: 'dispute_opened',
    disputeId: 'dispute-1',
    disputeStatus: 'open',
    disputeReason: 'fraud',
    transactionId: 'transaction-1',
    merchantAccountId: 'usd-sales',
    amount: '10.00',
    currency: 'USD',
    linked: true,
    ...overrides,
  };
}

function liveStatus(status = 'open') {
  const allowed = status === 'open';
  return {
    success: true,
    dispute: { id: 'dispute-1', status },
    actions: {
      status,
      accept: { allowed },
      evidence: { allowed },
      finalize: { allowed },
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await tick();
}

function createHarness({ actionOutcome = 'success', confirm = true } = {}) {
  const document = new FakeDocument();
  const list = document.register('dispute-list');
  const empty = document.register('empty-disputes');
  const pollingStatus = document.register('polling-status');
  const calls = [];
  const confirms = [];
  let intervalCallback = null;
  let confirmResult = confirm;

  async function fetch(url, options = {}) {
    calls.push({ url, options: structuredClone(options) });
    if (url === '/api/webhooks/activity') {
      return response(200, { success: true, disputes: [disputeRow()] });
    }
    if (url.endsWith('/status')) return response(200, liveStatus());
    if (url.endsWith('/actions/accept')) {
      if (actionOutcome === 'retry-unsafe') {
        return response(502, {
          success: false,
          retrySafe: false,
          error: { message: 'The action outcome is unknown. Do not retry.' },
        });
      }
      return response(200, {
        ...liveStatus('accepted'),
        action: 'accept',
        audit: { persisted: true },
        retrySafe: false,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'scripts', 'demo-disputes.js'),
    'utf8'
  );
  vm.runInNewContext(source, {
    document,
    fetch,
    HTMLTextAreaElement: FakeTextAreaElement,
    window: {
      confirm(message) {
        confirms.push(message);
        return confirmResult;
      },
      setInterval(callback) {
        intervalCallback = callback;
        return 1;
      },
    },
    console,
    encodeURIComponent,
  });

  return {
    calls,
    confirms,
    document,
    empty,
    list,
    pollingStatus,
    setConfirm(value) {
      confirmResult = value;
    },
    async ready() {
      await settle();
    },
    async poll() {
      assert.equal(typeof intervalCallback, 'function');
      await intervalCallback();
      await settle();
    },
    card() {
      return list.children[0];
    },
  };
}

function controls(card) {
  return {
    accept: card.querySelector('[data-dispute-action="accept"]'),
    evidence: card.querySelector('[data-evidence-input]'),
    evidenceButton: card.querySelectorAll('[data-dispute-action="evidence"]')
      .find((element) => element.tagName === 'BUTTON'),
    finalize: card.querySelector('[data-dispute-action="finalize"]'),
    status: card.querySelector('[data-action-status]'),
  };
}

test('dispute polling renders actionable cards and reuses cached live status', async () => {
  const harness = createHarness();
  await harness.ready();

  assert.equal(harness.list.children.length, 1);
  assert.equal(harness.empty.hidden, true);
  const initial = controls(harness.card());
  assert.equal(initial.accept.disabled, false);
  assert.equal(initial.evidence.disabled, false);
  assert.equal(initial.finalize.disabled, false);
  assert.match(initial.status.textContent, /actions are available/i);
  assert.equal(harness.calls.filter((call) => call.url.endsWith('/status')).length, 1);

  await harness.poll();

  assert.equal(harness.calls.filter((call) => call.url === '/api/webhooks/activity').length, 2);
  assert.equal(harness.calls.filter((call) => call.url.endsWith('/status')).length, 1);
  assert.equal(controls(harness.card()).accept.disabled, false);
});

test('polling preserves a focused evidence draft and its card', async () => {
  const harness = createHarness();
  await harness.ready();
  const originalCard = harness.card();
  const evidence = controls(originalCard).evidence;
  evidence.value = 'presenter draft';
  evidence.focus();

  await harness.poll();

  assert.equal(harness.card(), originalCard);
  assert.equal(evidence.value, 'presenter draft');
  assert.match(harness.pollingStatus.textContent, /paused while evidence is being edited/i);
});

test('accept requires confirmation and sends only the server-owned event path', async () => {
  const harness = createHarness({ confirm: false });
  await harness.ready();
  const accept = controls(harness.card()).accept;

  await accept.dispatch('click');
  await settle();
  assert.equal(harness.confirms.length, 1);
  assert.equal(harness.calls.filter((call) => call.url.includes('/actions/')).length, 0);

  harness.setConfirm(true);
  await accept.dispatch('click');
  await settle();
  const actionCall = harness.calls.find((call) => call.url.endsWith('/actions/accept'));
  assert.ok(actionCall);
  assert.equal(actionCall.url, '/demo/disputes/webhook-event-1/actions/accept');
  assert.deepEqual(JSON.parse(actionCall.options.body), { confirm: true });
  assert.equal(controls(harness.card()).accept.disabled, true);
});

test('a retry-unsafe action leaves every dispute control locked', async () => {
  const harness = createHarness({ actionOutcome: 'retry-unsafe' });
  await harness.ready();
  const cardControls = controls(harness.card());

  await cardControls.accept.dispatch('click');
  await settle();

  assert.equal(cardControls.accept.disabled, true);
  assert.equal(cardControls.evidence.disabled, true);
  assert.equal(cardControls.evidenceButton.disabled, true);
  assert.equal(cardControls.finalize.disabled, true);
  assert.match(cardControls.status.textContent, /unknown.*do not retry/i);
  assert.equal(
    harness.calls.filter((call) => call.url.endsWith('/status')).length,
    1,
    'retry-unsafe outcomes must not trigger a status refresh that re-enables controls'
  );
});
