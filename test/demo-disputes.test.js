'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  actionState,
  activityRows,
  createDemoDisputesRouter,
  requireDisputeContext,
  safeDisputeSummary,
} = require('../routes/demo-disputes');

const ROOT = path.join(__dirname, '..');

function rootEvent(overrides = {}) {
  return {
    id: 'root-event',
    type: 'transaction',
    gatewayMerchantId: 'gateway-demo',
    scenarioId: 'sandbox-dispute-usd',
    intent: { currency: 'USD', paymentType: 'one_time' },
    resolvedMerchantAccountId: 'usd-sales',
    responseMerchantAccountId: 'usd-sales',
    verified: true,
    braintreeId: 'txn-disputed',
    amount: '10.00',
    currency: 'USD',
    relatedEventId: null,
    ...overrides,
  };
}

function webhookEvent(overrides = {}) {
  return {
    id: 'webhook-event',
    type: 'webhook',
    gatewayMerchantId: 'gateway-demo',
    webhookKind: 'dispute_opened',
    webhookTimestamp: '2026-11-02T12:00:00.000Z',
    disputeId: 'dispute-demo',
    disputeStatus: 'open',
    disputeReason: 'fraud',
    relatedEventId: 'root-event',
    resolvedMerchantAccountId: 'usd-sales',
    responseMerchantAccountId: 'usd-sales',
    verified: true,
    braintreeId: 'txn-disputed',
    amount: '10.00',
    currency: 'USD',
    ...overrides,
  };
}

function fakeCatalog(overrides = {}) {
  const accounts = overrides.accounts || [{
    merchantAccountId: 'usd-sales',
    currency: 'USD',
    status: 'active',
    label: 'US Store',
  }];
  return {
    getState() {
      return {
        status: 'ok',
        gatewayMerchantId: 'gateway-demo',
        accounts,
        ...(overrides.state || {}),
      };
    },
    getMerchantAccountById(id) {
      return accounts.find((account) => account.merchantAccountId === id);
    },
  };
}

function fakeStore(events = [rootEvent(), webhookEvent()]) {
  const records = new Map(events.map((event) => [event.id, structuredClone(event)]));
  const appended = [];
  return {
    appended,
    get(id) {
      const value = records.get(id);
      return value ? structuredClone(value) : undefined;
    },
    list() {
      return [...records.values()].map((event) => structuredClone(event));
    },
    append(event) {
      const stored = { ...structuredClone(event), id: `audit-${appended.length + 1}` };
      appended.push(stored);
      records.set(stored.id, stored);
      return structuredClone(stored);
    },
  };
}

function fakeGateway(options = {}) {
  const calls = {
    find: [],
    accept: [],
    evidence: [],
    finalize: [],
  };
  let status = options.status || 'open';

  function currentDispute() {
    return {
      id: 'dispute-demo',
      status,
      kind: 'chargeback',
      reason: 'fraud',
      amountDisputed: '10.00',
      currencyIsoCode: options.currencyIsoCode || 'USD',
      merchantAccountId: options.merchantAccountId || 'usd-sales',
      transactionDetails: {
        id: options.transactionId || 'txn-disputed',
        merchantAccountId: options.merchantAccountId || 'usd-sales',
      },
      replyByDate: '2026-11-15',
      customer: { email: 'must-not-leak@example.test' },
    };
  }

  return {
    calls,
    async findDispute(request) {
      calls.find.push(structuredClone(request));
      if (options.findError) throw options.findError;
      return { success: true, dispute: currentDispute() };
    },
    async acceptDispute(request) {
      calls.accept.push(structuredClone(request));
      if (options.acceptError) throw options.acceptError;
      if (options.acceptFailure) return { success: false, message: 'Acceptance failed' };
      status = 'accepted';
      return { success: true, dispute: currentDispute() };
    },
    async addDisputeTextEvidence(request) {
      calls.evidence.push(structuredClone(request));
      if (options.evidenceError) throw options.evidenceError;
      if (options.evidenceFailure) return { success: false, message: 'Evidence failed' };
      return { success: true, evidence: { id: 'evidence-id', content: request.content } };
    },
    async finalizeDispute(request) {
      calls.finalize.push(structuredClone(request));
      if (options.finalizeError) throw options.finalizeError;
      if (options.finalizeFailure) return { success: false, message: 'Finalize failed' };
      status = 'disputed';
      return { success: true, dispute: currentDispute() };
    },
  };
}

function routeHandler(router, method, routePath) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route was not registered`);
  return layer.route.stack.at(-1).handle;
}

function hasRoute(router, method, routePath) {
  return router.stack.some(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods[method]
  );
}

function invoke(handler, request = {}) {
  return new Promise((resolve, reject) => {
    let sent = false;
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        sent = true;
        resolve({ status: this.statusCode, body: structuredClone(payload) });
        return this;
      },
      render(view, model) {
        sent = true;
        resolve({ status: this.statusCode, view, body: structuredClone(model) });
        return this;
      },
    };
    const req = { params: {}, query: {}, body: {}, ...request };
    Promise.resolve(handler(req, res, (error) => {
      if (error) reject(error);
      else reject(new Error('next() called without an error'));
    })).then(() => {
      if (!sent) reject(new Error('Route completed without a response'));
    }, reject);
  });
}

function harness(options = {}) {
  const store = options.store || fakeStore();
  const gateway = options.gateway || fakeGateway();
  const catalog = options.catalog || fakeCatalog();
  const errors = [];
  const router = createDemoDisputesRouter({
    gatewayClient: gateway,
    catalogService: catalog,
    store,
    logger: { error(...args) { errors.push(args); } },
  });
  return {
    router,
    store,
    gateway,
    catalog,
    errors,
    page: (request) => invoke(routeHandler(router, 'get', '/'), request),
    status: (eventId = 'webhook-event') => invoke(
      routeHandler(router, 'get', '/:eventId/status'),
      { params: { eventId } }
    ),
    action: (action, body = {}, eventId = 'webhook-event') => invoke(
      routeHandler(router, 'post', '/:eventId/actions/:action'),
      { params: { eventId, action }, body }
    ),
  };
}

test('disputes page uses the consolidated safe webhook projection without a parallel endpoint', async () => {
  const demo = harness();
  const page = await demo.page();
  assert.equal(page.status, 200);
  assert.equal(page.view, 'demo-disputes');
  assert.equal(page.body.layout, false);
  assert.equal(page.body.initialDisputeCount, 1);
  assert.equal(hasRoute(demo.router, 'get', '/activity'), false);

  const disputes = activityRows(demo.catalog, demo.store);
  assert.deepEqual(disputes[0], {
    eventId: 'webhook-event',
    receivedAt: '2026-11-02T12:00:00.000Z',
    webhookKind: 'dispute_opened',
    disputeId: 'dispute-demo',
    disputeStatus: 'open',
    disputeReason: 'fraud',
    transactionId: 'txn-disputed',
    merchantAccountId: 'usd-sales',
    amount: '10.00',
    currency: 'USD',
    linked: true,
    actionable: true,
  });
  assert.doesNotMatch(JSON.stringify(disputes), /request|response|payload|signature/i);
});

test('live status derives dispute and account identifiers only from the signed event context', async () => {
  const demo = harness();
  const response = await demo.status();
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.dispute.status, 'open');
  assert.equal(response.body.dispute.customer, undefined);
  assert.equal(response.body.actions.accept.allowed, true);
  assert.deepEqual(demo.gateway.calls.find, [{
    disputeId: 'dispute-demo',
    merchantAccountId: 'usd-sales',
  }]);
});

test('historical, unlinked, mismatched, and inactive dispute events are read-only before Braintree', async (t) => {
  const cases = [
    ['historical gateway', webhookEvent({ gatewayMerchantId: 'old-gateway' }), fakeCatalog(), 'HISTORICAL_GATEWAY_READ_ONLY'],
    ['unlinked webhook', webhookEvent({ verified: false, relatedEventId: null }), fakeCatalog(), 'UNLINKED_DISPUTE_READ_ONLY'],
    ['account mismatch', webhookEvent({ responseMerchantAccountId: 'other-account' }), fakeCatalog(), 'DISPUTE_ROUTE_UNVERIFIED'],
    ['transaction mismatch', webhookEvent({ braintreeId: 'other-transaction' }), fakeCatalog(), 'DISPUTE_TRANSACTION_UNVERIFIED'],
    ['currency mismatch', webhookEvent({ currency: 'EUR' }), fakeCatalog(), 'DISPUTE_CURRENCY_UNVERIFIED'],
    ['inactive account', webhookEvent(), fakeCatalog({ accounts: [] }), 'MERCHANT_ACCOUNT_INACTIVE'],
  ];

  for (const [name, event, catalog, code] of cases) {
    await t.test(name, async () => {
      const store = fakeStore([rootEvent(), event]);
      const demo = harness({ store, catalog });
      const response = await demo.status();
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, code);
      assert.deepEqual(demo.gateway.calls.find, []);
    });
  }
});

test('a live dispute currency mismatch blocks actions', async () => {
  const demo = harness({ gateway: fakeGateway({ currencyIsoCode: 'EUR' }) });
  const response = await demo.status();
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'DISPUTE_CURRENCY_MISMATCH');
  assert.deepEqual(demo.gateway.calls.accept, []);
});

test('accept requires confirmation, refetches live state, and records a non-replayable action', async () => {
  const demo = harness();
  const missingConfirmation = await demo.action('accept');
  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.body.error.code, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(demo.gateway.calls.accept, []);

  const response = await demo.action('accept', { confirm: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.dispute.status, 'accepted');
  assert.equal(response.body.actions.accept.allowed, false);
  assert.equal(response.body.retrySafe, false);
  assert.deepEqual(demo.gateway.calls.accept, [{
    disputeId: 'dispute-demo',
    merchantAccountId: 'usd-sales',
  }]);
  assert.equal(demo.gateway.calls.find.length, 2);
  assert.equal(demo.store.appended.length, 1);
  assert.equal(demo.store.appended[0].type, 'dispute_action');
  assert.equal(demo.store.appended[0].action, 'accept');
  assert.equal(demo.store.appended[0].relatedEventId, 'webhook-event');
});

test('text evidence is validated, sent once, and never persisted or returned', async () => {
  const demo = harness();
  const emptyEvidence = await demo.action('evidence', { evidence: '   ' });
  assert.equal(emptyEvidence.status, 400);
  assert.equal(emptyEvidence.body.error.code, 'INVALID_EVIDENCE');

  const evidence = 'private-demo-evidence-should-not-persist';
  const response = await demo.action('evidence', { evidence });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.retrySafe, false);
  assert.deepEqual(demo.gateway.calls.evidence, [{
    disputeId: 'dispute-demo',
    merchantAccountId: 'usd-sales',
    content: evidence,
  }]);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(evidence));
  assert.doesNotMatch(JSON.stringify(demo.store.appended), new RegExp(evidence));
  assert.deepEqual(demo.store.appended[0].request, {
    action: 'evidence',
    evidenceProvided: true,
  });
});

test('finalize requires an open dispute and explicit confirmation', async () => {
  const closed = harness({ gateway: fakeGateway({ status: 'won' }) });
  const closedResponse = await closed.action('finalize', { confirm: true });
  assert.equal(closedResponse.status, 409);
  assert.equal(closedResponse.body.error.code, 'ACTION_NOT_ALLOWED');
  assert.deepEqual(closed.gateway.calls.finalize, []);

  const open = harness();
  const response = await open.action('finalize', { confirm: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.dispute.status, 'disputed');
  assert.equal(response.body.actions.finalize.allowed, false);
  assert.deepEqual(open.gateway.calls.finalize, [{
    disputeId: 'dispute-demo',
    merchantAccountId: 'usd-sales',
  }]);
});

test('an ambiguous gateway error disables retry and does not persist supplied evidence', async () => {
  const evidence = 'evidence-with-ambiguous-outcome';
  const demo = harness({ gateway: fakeGateway({ evidenceError: new Error('connection reset') }) });
  const response = await demo.action('evidence', { evidence });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_ACTION_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(evidence));
  assert.deepEqual(demo.store.appended, []);
});

test('a mutation response without explicit success is ambiguous and never audited as complete', async () => {
  const gateway = fakeGateway();
  gateway.acceptDispute = async (request) => {
    gateway.calls.accept.push(structuredClone(request));
    return undefined;
  };
  const demo = harness({ gateway });

  const response = await demo.action('accept', { confirm: true });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_ACTION_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.deepEqual(demo.store.appended, []);
});

test('a post-mutation verification failure is ambiguous and must not permit retry', async () => {
  const gateway = fakeGateway();
  const originalFind = gateway.findDispute.bind(gateway);
  let findCount = 0;
  gateway.findDispute = async (request) => {
    const result = await originalFind(request);
    findCount += 1;
    if (findCount === 2) result.dispute.currencyIsoCode = 'EUR';
    return result;
  };
  const demo = harness({ gateway });

  const response = await demo.action('accept', { confirm: true });

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_ACTION_OUTCOME_UNVERIFIED');
  assert.equal(response.body.retrySafe, false);
  assert.equal(gateway.calls.accept.length, 1);
  assert.equal(gateway.calls.find.length, 2);
  assert.deepEqual(demo.store.appended, []);
});

test('concurrent actions for one dispute are rejected before a second mutation', async () => {
  const gateway = fakeGateway();
  const originalAccept = gateway.acceptDispute.bind(gateway);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  gateway.acceptDispute = async (request) => {
    await pending;
    return originalAccept(request);
  };
  const demo = harness({ gateway });

  const first = demo.action('accept', { confirm: true });
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await demo.action('finalize', { confirm: true });
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.error.code, 'DISPUTE_ACTION_IN_PROGRESS');
  assert.equal(concurrent.body.retrySafe, true);
  assert.deepEqual(gateway.calls.finalize, []);

  release();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal(gateway.calls.accept.length, 1);
});

test('concurrent actions through different webhook events for one dispute share a lock', async () => {
  const gateway = fakeGateway();
  const originalAccept = gateway.acceptDispute.bind(gateway);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  gateway.acceptDispute = async (request) => {
    await pending;
    return originalAccept(request);
  };
  const store = fakeStore([
    rootEvent(),
    webhookEvent({
      id: 'webhook-event-a',
      webhookTimestamp: '2026-11-02T12:00:00.000Z',
    }),
    webhookEvent({
      id: 'webhook-event-b',
      webhookTimestamp: '2026-11-02T12:05:00.000Z',
    }),
  ]);
  const demo = harness({ gateway, store });

  const first = demo.action('accept', { confirm: true }, 'webhook-event-a');
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await demo.action(
    'finalize',
    { confirm: true },
    'webhook-event-b'
  );
  release();
  const completed = await first;

  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.error.code, 'DISPUTE_ACTION_IN_PROGRESS');
  assert.equal(concurrent.body.retrySafe, true);
  assert.deepEqual(gateway.calls.finalize, []);
  assert.equal(completed.status, 200);
  assert.equal(gateway.calls.accept.length, 1);
});

test('helpers derive trusted context and expose only allowlisted dispute fields', () => {
  const context = requireDisputeContext('webhook-event', fakeCatalog(), fakeStore());
  assert.equal(context.disputeId, 'dispute-demo');
  assert.equal(context.merchantAccountId, 'usd-sales');

  const summary = safeDisputeSummary({
    id: 'dispute-demo',
    status: 'OPEN',
    amountDisputed: '10.00',
    merchantAccountId: 'usd-sales',
    transactionDetails: { id: 'txn-disputed' },
    customer: { email: 'secret@example.test' },
  });
  assert.equal(summary.status, 'open');
  assert.equal(summary.customer, undefined);
  assert.equal(actionState({ status: 'open' }).accept.allowed, true);
  assert.equal(actionState({ status: 'lost' }).accept.allowed, false);
});

test('browser dispute UI polls without reload, preserves drafts, and uses textContent', () => {
  const script = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'demo-disputes.js'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'views', 'demo-disputes.hbs'), 'utf8');
  assert.match(script, /setInterval\(refreshActivity, 5000\)/);
  assert.match(script, /\/api\/webhooks\/activity/);
  assert.doesNotMatch(script, /\/demo\/disputes\/activity/);
  assert.match(script, /LIVE_STATUS_TTL_MS = 30000/);
  assert.match(script, /liveStatusCache/);
  assert.match(script, /textContent/);
  assert.match(script, /draftEvidence/);
  assert.match(script, /actionsInProgress/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.doesNotMatch(script, /location\.reload/);
  assert.match(script, /window\.confirm/);
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /HTTPS tunnel exposes only the signed Braintree webhook listener/);
});
