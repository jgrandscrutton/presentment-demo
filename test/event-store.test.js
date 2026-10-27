'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EVENT_FIELDS,
  createEventStore,
} = require('../lib/events/store');
const { REDACTED } = require('../lib/inspector/redact');

function temporaryStore(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presentment-events-'));
  const filePath = path.join(directory, 'nested', 'events.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  return {
    directory,
    filePath,
    store: createEventStore({
      filePath,
      generateId: () => 'event-1',
      getGatewayMerchantId: () => 'gateway-merchant-1',
      now: () => new Date('2026-10-14T09:30:00.000Z'),
      ...overrides,
    }),
  };
}

test('append stores the complete event shape and persists only redacted plain data', (t) => {
  class FakeSdkTransaction {
    constructor() {
      this.id = 'txn-1';
      this.status = 'submitted_for_settlement';
      this.merchantAccountId = 'vmUSD';
      this.currencyIsoCode = 'USD';
      this.amount = '19.99';
      this.paymentMethodToken = 'vault-token-do-not-store';
      this.creditCard = {
        cardType: 'Visa',
        last4: '1111',
        number: '4111111111111111',
      };
    }

    void() {}
  }

  const { filePath, store } = temporaryStore(t);
  const event = store.append({
    type: 'transaction.sale',
    scenarioId: 'us-phone-purchase',
    intent: { currency: 'USD', paymentType: 'one_time' },
    resolvedMerchantAccountId: 'vmUSD',
    responseMerchantAccountId: 'vmUSD',
    verified: true,
    paymentMethodType: 'credit_card',
    amount: '19.99',
    currency: 'USD',
    outcome: 'submitted_for_settlement',
    braintreeId: 'txn-1',
    request: {
      paymentMethodNonce: 'fake-valid-nonce',
      clientToken: 'client-token-do-not-store',
      merchantAccountId: 'vmUSD',
    },
    response: new FakeSdkTransaction(),
    decision: { reason: 'Demo policy match: USD + one-time' },
  });

  assert.equal(event.id, 'event-1');
  assert.equal(event.timestamp, '2026-10-14T09:30:00.000Z');
  assert.equal(event.gatewayMerchantId, 'gateway-merchant-1');
  assert.equal(event.request.paymentMethodNonce, REDACTED);
  assert.equal(event.request.clientToken, REDACTED);
  assert.equal(event.request.merchantAccountId, 'vmUSD');
  assert.equal(event.response.paymentMethodToken, REDACTED);
  assert.equal(event.response.creditCard.number, REDACTED);
  assert.equal(event.response.creditCard.last4, '1111');
  assert.equal(event.response.void, undefined);
  assert.equal(event.relatedEventId, null);
  assert.equal(event.decision.reason, 'Demo policy match: USD + one-time');
  for (const field of EVENT_FIELDS) {
    assert.ok(Object.hasOwn(event, field), `missing canonical event field ${field}`);
  }

  const persistedSource = fs.readFileSync(filePath, 'utf8');
  assert.equal(persistedSource.includes('fake-valid-nonce'), false);
  assert.equal(persistedSource.includes('client-token-do-not-store'), false);
  assert.equal(persistedSource.includes('vault-token-do-not-store'), false);
  assert.equal(persistedSource.includes('4111111111111111'), false);
  assert.equal(persistedSource.includes('vmUSD'), true);
  assert.deepEqual(JSON.parse(persistedSource), [event]);

  const files = fs.readdirSync(path.dirname(filePath));
  assert.deepEqual(files, ['events.json']);
});

test('list and get return defensive copies in append order', (t) => {
  let nextId = 0;
  const { store } = temporaryStore(t, {
    generateId: () => `event-${++nextId}`,
  });

  store.append({ type: 'route.resolved', scenarioId: 'first' });
  store.append({ type: 'transaction.sale', scenarioId: 'second' });

  const listed = store.list();
  assert.deepEqual(listed.map((event) => event.id), ['event-1', 'event-2']);
  assert.equal(store.get('event-2').scenarioId, 'second');
  assert.equal(store.get('missing'), undefined);

  listed[0].scenarioId = 'mutated';
  listed.push({ id: 'event-injected' });
  const fetched = store.get('event-1');
  fetched.intent = { currency: 'JPY' };

  assert.equal(store.get('event-1').scenarioId, 'first');
  assert.equal(store.get('event-1').intent, null);
  assert.equal(store.list().length, 2);
});

test('events survive a new store instance and clear is persisted', (t) => {
  const { filePath, store } = temporaryStore(t);
  store.append({
    type: 'route.resolved',
    intent: { currency: 'JPY', paymentType: 'one_time' },
    outcome: 'no_route',
  });

  const reopened = createEventStore({
    filePath,
    generateId: () => 'event-2',
    now: () => '2026-10-14T10:00:00.000Z',
  });
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get('event-1').outcome, 'no_route');

  assert.equal(reopened.clear(), 1);
  assert.deepEqual(reopened.list(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), []);

  const afterClear = createEventStore({ filePath });
  assert.deepEqual(afterClear.list(), []);
});

test('multiple store instances append without overwriting one another', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presentment-events-shared-'));
  const filePath = path.join(directory, 'events.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  const firstStore = createEventStore({
    filePath,
    generateId: () => 'event-from-first',
    getGatewayMerchantId: () => 'gateway-merchant-1',
    now: () => '2026-10-14T11:00:00.000Z',
  });
  const secondStore = createEventStore({
    filePath,
    generateId: () => 'event-from-second',
    getGatewayMerchantId: () => 'gateway-merchant-1',
    now: () => '2026-10-14T11:00:01.000Z',
  });

  firstStore.append({ type: 'route_resolution', scenarioId: 'first' });
  secondStore.append({ type: 'transaction', scenarioId: 'second' });

  assert.deepEqual(
    firstStore.list().map((event) => event.id),
    ['event-from-first', 'event-from-second']
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(filePath, 'utf8')).map((event) => event.scenarioId),
    ['first', 'second']
  );
});

test('append validates event type and generated IDs without altering persisted data', (t) => {
  const { filePath, store } = temporaryStore(t);

  assert.throws(() => store.append(null), /event must be an object/);
  assert.throws(() => store.append({}), /event\.type must be a non-empty string/);
  assert.equal(fs.existsSync(filePath), false);

  store.append({ type: 'route.resolved' });
  assert.throws(
    () => store.append({ type: 'route.resolved' }),
    /Duplicate generated event ID "event-1"/
  );
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).length, 1);
});

test('append gets gateway identity from the store and cannot be spoofed by event input', (t) => {
  let gatewayMerchantId = 'gateway-merchant-1';
  const { store } = temporaryStore(t, {
    getGatewayMerchantId: () => gatewayMerchantId,
  });

  const first = store.append({
    type: 'route.resolved',
    gatewayMerchantId: 'spoofed-merchant',
  });
  assert.equal(first.gatewayMerchantId, 'gateway-merchant-1');

  gatewayMerchantId = '';
  assert.throws(
    () => store.append({ type: 'route.resolved' }),
    /getGatewayMerchantId\(\) result must be a non-empty string/
  );
  assert.equal(store.list().length, 1);
});

test('existing events without gateway metadata remain unchanged', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presentment-events-legacy-'));
  const filePath = path.join(directory, 'events.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  const legacyEvent = {
    id: 'legacy-event',
    timestamp: '2026-10-13T08:00:00.000Z',
    type: 'route_resolution',
    scenarioId: 'legacy-scenario',
  };
  fs.writeFileSync(filePath, `${JSON.stringify([legacyEvent], null, 2)}\n`, 'utf8');

  const store = createEventStore({
    filePath,
    generateId: () => 'new-event',
    getGatewayMerchantId: () => 'gateway-merchant-1',
    now: () => '2026-10-14T08:00:00.000Z',
  });

  assert.deepEqual(store.get('legacy-event'), legacyEvent);
  assert.equal(Object.hasOwn(store.get('legacy-event'), 'gatewayMerchantId'), false);

  const appended = store.append({ type: 'route_resolution' });
  assert.equal(appended.gatewayMerchantId, 'gateway-merchant-1');

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(persisted[0], legacyEvent);
  assert.equal(Object.hasOwn(persisted[0], 'gatewayMerchantId'), false);
});

test('constructor fails loudly for malformed or invalid persisted data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presentment-events-invalid-'));
  const filePath = path.join(directory, 'events.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  fs.writeFileSync(filePath, '{not-json', 'utf8');
  assert.throws(() => createEventStore({ filePath }), /Could not parse event store/);

  fs.writeFileSync(filePath, JSON.stringify({ events: [] }), 'utf8');
  assert.throws(() => createEventStore({ filePath }), /must contain a JSON array/);

  fs.writeFileSync(filePath, JSON.stringify([{ id: 'event-1' }]), 'utf8');
  assert.throws(() => createEventStore({ filePath }), /timestamp must be a non-empty string/);
});
