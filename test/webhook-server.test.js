'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  createWebhookReceiverApp,
  parseWebhookPort,
  startWebhookReceiver,
} = require('../webhook-server');

function fakeStore() {
  const events = [];
  function persist(event, isDuplicate = () => false) {
    const stored = { ...event, id: `event-${events.length + 1}` };
    if (events.some((candidate) => isDuplicate(
      structuredClone(candidate),
      structuredClone(stored)
    ))) {
      return null;
    }
    events.push(stored);
    return stored;
  }
  return {
    append(event) {
      return persist(event);
    },
    appendIfAbsent(event, isDuplicate) {
      return persist(event, isDuplicate);
    },
    list() {
      return structuredClone(events);
    },
  };
}

function requestApp(app, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
    );
    if (!Object.hasOwn(normalizedHeaders, 'content-length')) {
      normalizedHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    const req = Readable.from(body === '' ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = path;
    req.headers = normalizedHeaders;
    req.socket = { encrypted: false };

    const responseHeaders = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders.set(String(name).toLowerCase(), value);
      },
      getHeader(name) {
        return responseHeaders.get(String(name).toLowerCase());
      },
      removeHeader(name) {
        responseHeaders.delete(String(name).toLowerCase());
      },
      write(chunk) {
        if (chunk != null) chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk != null) chunks.push(Buffer.from(chunk));
        resolve({
          status: this.statusCode,
          headers: Object.fromEntries(responseHeaders),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      },
    };

    app.handle(req, res, reject);
  });
}

test('webhook-only receiver exposes the signed POST route and nothing else', () => {
  const app = createWebhookReceiverApp({
    gatewayMerchantId: 'sandbox-merchant',
    gatewayClient: {
      async parseWebhookNotification() {
        throw Object.assign(new Error('invalid'), { name: 'InvalidSignatureError' });
      },
    },
    store: fakeStore(),
    logger: { warn() {}, info() {}, error() {} },
  });

  const mountedRouters = app.router.stack.filter(
    (layer) => Array.isArray(layer.handle?.stack)
  );
  assert.equal(mountedRouters.length, 1);
  assert.deepEqual(
    mountedRouters[0].handle.stack
      .filter((layer) => layer.route)
      .map((layer) => ({ path: layer.route.path, methods: layer.route.methods })),
    [{
      path: '/braintree',
      methods: Object.assign(Object.create(null), { post: true }),
    }]
  );
  assert.equal(app.get('x-powered-by'), false);
});

test('webhook receiver port validation and binding stay loopback-only', async () => {
  assert.equal(parseWebhookPort('3001'), 3001);
  for (const value of [0, 65536, 'not-a-port', 2.5]) {
    assert.throws(() => parseWebhookPort(value), /WEBHOOK_PORT/);
  }

  assert.throws(
    () => startWebhookReceiver({
      host: '0.0.0.0',
      gatewayMerchantId: 'sandbox-merchant',
      gatewayClient: {},
      store: fakeStore(),
    }),
    /loopback/
  );
});

test('the HTTP middleware pipeline rejects malformed and oversized forms without echoing signed data', async () => {
  const parseCalls = [];
  const logEntries = [];
  const app = createWebhookReceiverApp({
    gatewayMerchantId: 'sandbox-merchant',
    gatewayClient: {
      async parseWebhookNotification(input) {
        parseCalls.push(input);
        throw Object.assign(new Error('invalid'), { name: 'InvalidSignatureError' });
      },
    },
    store: fakeStore(),
    logger: {
      warn(...args) { logEntries.push(args); },
      info(...args) { logEntries.push(args); },
      error(...args) { logEntries.push(args); },
    },
  });
  const malformedSecret = 'malformed-signed-value-must-not-echo';
  const malformedResponse = await requestApp(app, {
    method: 'POST',
    path: '/api/webhooks/braintree',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `bt_signature=${malformedSecret}&unexpected=value`,
  });
  assert.equal(malformedResponse.status, 400);
  assert.match(malformedResponse.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(malformedResponse.text).code, 'INVALID_WEBHOOK_FORM');
  assert.doesNotMatch(malformedResponse.text, new RegExp(malformedSecret));

  const unsupportedCharsetSecret = 'unsupported-charset-value-must-not-echo';
  const charsetResponse = await requestApp(app, {
    method: 'POST',
    path: '/api/webhooks/braintree',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=x-private-unsupported',
    },
    body: `bt_signature=${unsupportedCharsetSecret}&bt_payload=value`,
  });
  assert.equal(charsetResponse.status, 400);
  assert.match(charsetResponse.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(charsetResponse.text).code, 'INVALID_WEBHOOK_BODY');
  assert.doesNotMatch(charsetResponse.text, new RegExp(unsupportedCharsetSecret));

  const oversizedSecret = 'oversized-signed-value-must-not-echo';
  const oversizedResponse = await requestApp(app, {
    method: 'POST',
    path: '/api/webhooks/braintree',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `bt_signature=value&bt_payload=${oversizedSecret}${'x'.repeat(1024 * 1024)}`,
  });
  assert.equal(oversizedResponse.status, 413);
  assert.match(oversizedResponse.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(oversizedResponse.text).code, 'WEBHOOK_BODY_TOO_LARGE');
  assert.doesNotMatch(oversizedResponse.text, new RegExp(oversizedSecret));

  assert.deepEqual(parseCalls, []);
  const logged = JSON.stringify(logEntries);
  for (const secret of [
    malformedSecret,
    unsupportedCharsetSecret,
    oversizedSecret,
  ]) {
    assert.doesNotMatch(logged, new RegExp(secret));
  }
});
