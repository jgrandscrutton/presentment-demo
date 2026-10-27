'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { redact } = require('../inspector/redact');

const DEFAULT_FILE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'runtime',
  'events.json'
);

const EVENT_FIELDS = Object.freeze([
  'gatewayMerchantId',
  'stage',
  'endpoint',
  'scenarioId',
  'type',
  'action',
  'intent',
  'transactionMode',
  'expectedOutcome',
  'resolvedMerchantAccountId',
  'responseMerchantAccountId',
  'verified',
  'paymentMethodType',
  'amount',
  'currency',
  'outcome',
  'transactionStatus',
  'braintreeId',
  'originalBraintreeId',
  'relatedEventId',
  'request',
  'response',
]);

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function timestampFrom(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now() must return a valid Date, timestamp, or date string');
  }
  return date.toISOString();
}

function readEvents(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse event store at ${filePath}: ${error.message}`, {
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError(`Event store at ${filePath} must contain a JSON array`);
  }

  const ids = new Set();
  return parsed.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError(`Event at index ${index} in ${filePath} must be an object`);
    }
    assertNonEmptyString(event.id, `Event at index ${index}.id`);
    assertNonEmptyString(event.timestamp, `Event at index ${index}.timestamp`);
    assertNonEmptyString(event.type, `Event at index ${index}.type`);
    if (ids.has(event.id)) {
      throw new TypeError(`Duplicate event ID "${event.id}" in ${filePath}`);
    }
    ids.add(event.id);

    // Flatten and sanitize data loaded from disk too. This protects callers if
    // a prior version wrote a wider object shape.
    return redact(event);
  });
}

function writeEventsAtomically(filePath, events) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(events, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function waitForLock() {
  Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
}

function withFileLock(filePath, operation) {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });

  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') {
          continue;
        }
        throw inspectionError;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for event-store lock at ${lockPath}`);
      }

      waitForLock();
    }
  }

  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

class EventStore {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_FILE_PATH;
    this.now = options.now || (() => new Date());
    this.generateId = options.generateId || (() => crypto.randomUUID());
    this.getGatewayMerchantId =
      options.getGatewayMerchantId || (() => process.env.MERCHANT_ID);

    assertNonEmptyString(this.filePath, 'filePath');
    if (typeof this.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (typeof this.generateId !== 'function') {
      throw new TypeError('generateId must be a function');
    }
    if (typeof this.getGatewayMerchantId !== 'function') {
      throw new TypeError('getGatewayMerchantId must be a function');
    }

    this.events = readEvents(this.filePath);
  }

  append(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('event must be an object');
    }

    // Redaction also flattens SDK class instances and removes functions,
    // accessors, binary data, and cycles before they enter memory or disk.
    const safeInput = redact(event);
    assertNonEmptyString(safeInput.type, 'event.type');

    const id = this.generateId();
    assertNonEmptyString(id, 'generateId() result');
    const gatewayMerchantId = this.getGatewayMerchantId();
    assertNonEmptyString(
      gatewayMerchantId,
      'getGatewayMerchantId() result'
    );
    const defaults = Object.fromEntries(EVENT_FIELDS.map((field) => [field, null]));
    const stored = {
      ...defaults,
      ...safeInput,
      // The store owns this value so callers cannot attribute an event to a
      // different gateway. Existing events loaded from disk are left alone.
      gatewayMerchantId,
      id,
      timestamp: timestampFrom(this.now()),
    };

    // Apply once more after adding generated fields so no custom clock or ID
    // implementation can accidentally introduce a sensitive value.
    const safeEvent = redact(stored);
    withFileLock(this.filePath, () => {
      const currentEvents = readEvents(this.filePath);
      if (currentEvents.some((candidate) => candidate.id === id)) {
        throw new TypeError(`Duplicate generated event ID "${id}"`);
      }

      const nextEvents = [...currentEvents, safeEvent];
      writeEventsAtomically(this.filePath, nextEvents);
      this.events = nextEvents;
    });

    return clone(safeEvent);
  }

  list() {
    this.events = readEvents(this.filePath);
    return clone(this.events);
  }

  get(id) {
    this.events = readEvents(this.filePath);
    const event = this.events.find((candidate) => candidate.id === id);
    return event ? clone(event) : undefined;
  }

  clear() {
    let removedCount;
    withFileLock(this.filePath, () => {
      const currentEvents = readEvents(this.filePath);
      removedCount = currentEvents.length;
      writeEventsAtomically(this.filePath, []);
      this.events = [];
    });
    return removedCount;
  }
}

function createEventStore(options) {
  return new EventStore(options);
}

const defaultStore = createEventStore();

module.exports = {
  DEFAULT_FILE_PATH,
  EVENT_FIELDS,
  EventStore,
  append: defaultStore.append.bind(defaultStore),
  clear: defaultStore.clear.bind(defaultStore),
  createEventStore,
  get: defaultStore.get.bind(defaultStore),
  list: defaultStore.list.bind(defaultStore),
};
