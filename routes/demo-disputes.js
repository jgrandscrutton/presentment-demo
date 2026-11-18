'use strict';

const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const eventStore = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const { disputeActivityRows } = require('./webhooks');

const DISPUTE_EVENT_TYPES = new Set(['webhook']);
const ACTIONS = new Set(['accept', 'evidence', 'finalize']);
const OPEN_STATUS = 'open';
const MAX_EVIDENCE_LENGTH = 4000;

class ApiProblem extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeStatus(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[ -]+/g, '_')
    : '';
}

function normalizeCurrency(value) {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function disputeFrom(value) {
  if (value?.dispute && typeof value.dispute === 'object') return value.dispute;
  return value && typeof value === 'object' ? value : null;
}

function transactionDetailsFrom(dispute) {
  if (dispute?.transactionDetails && typeof dispute.transactionDetails === 'object') {
    return dispute.transactionDetails;
  }
  if (dispute?.transaction && typeof dispute.transaction === 'object') {
    return dispute.transaction;
  }
  return null;
}

function safeDisputeSummary(dispute) {
  const transaction = transactionDetailsFrom(dispute);
  return {
    id: typeof dispute?.id === 'string' ? dispute.id : null,
    status: normalizeStatus(dispute?.status) || null,
    kind: typeof dispute?.kind === 'string' ? dispute.kind : null,
    reason: typeof dispute?.reason === 'string'
      ? dispute.reason
      : typeof dispute?.reasonCode === 'string'
        ? dispute.reasonCode
        : null,
    amountDisputed:
      typeof dispute?.amountDisputed === 'string' || typeof dispute?.amountDisputed === 'number'
        ? String(dispute.amountDisputed)
        : null,
    currency: typeof dispute?.currencyIsoCode === 'string'
      ? dispute.currencyIsoCode
      : null,
    merchantAccountId: typeof dispute?.merchantAccountId === 'string'
      ? dispute.merchantAccountId
      : typeof transaction?.merchantAccountId === 'string'
        ? transaction.merchantAccountId
        : null,
    transactionId: typeof transaction?.id === 'string' ? transaction.id : null,
    receivedDate: typeof dispute?.receivedDate === 'string' ? dispute.receivedDate : null,
    replyByDate: typeof dispute?.replyByDate === 'string' ? dispute.replyByDate : null,
  };
}

function safeCatalogState(service) {
  try {
    return service.getState();
  } catch {
    return null;
  }
}

function availableAccount(service, merchantAccountId) {
  let account;
  if (typeof service.getMerchantAccountById === 'function') {
    account = service.getMerchantAccountById(merchantAccountId);
  } else if (typeof service.getMerchantAccounts === 'function') {
    account = service.getMerchantAccounts().find(
      (candidate) => candidate.merchantAccountId === merchantAccountId
    );
  }
  return account?.status === 'active' ? account : null;
}

function requireDisputeContext(eventId, service, store) {
  if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId)) {
    throw new ApiProblem(400, 'INVALID_EVENT_ID', 'Choose a valid dispute webhook event.');
  }

  const event = store.get(eventId);
  if (!event) {
    throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'That dispute webhook event was not found.');
  }
  if (
    !DISPUTE_EVENT_TYPES.has(event.type) ||
    typeof event.disputeId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(event.disputeId)
  ) {
    throw new ApiProblem(
      409,
      'DISPUTE_WEBHOOK_REQUIRED',
      'Dispute actions require a verified dispute webhook event.'
    );
  }

  const state = safeCatalogState(service);
  if (state?.status !== 'ok' || typeof state.gatewayMerchantId !== 'string') {
    throw new ApiProblem(
      503,
      'CATALOG_UNAVAILABLE',
      'Merchant account discovery is unavailable. Refresh the gateway catalog first.'
    );
  }
  if (!event.gatewayMerchantId || event.gatewayMerchantId !== state.gatewayMerchantId) {
    throw new ApiProblem(
      409,
      'HISTORICAL_GATEWAY_READ_ONLY',
      'This dispute belongs to a different or unknown gateway configuration and is read-only.'
    );
  }
  if (event.verified !== true || typeof event.relatedEventId !== 'string') {
    throw new ApiProblem(
      409,
      'UNLINKED_DISPUTE_READ_ONLY',
      'This dispute could not be linked to a verified local transaction and is read-only.'
    );
  }

  const root = store.get(event.relatedEventId);
  if (
    !root ||
    root.type !== 'transaction' ||
    root.relatedEventId ||
    root.verified !== true ||
    root.gatewayMerchantId !== state.gatewayMerchantId
  ) {
    throw new ApiProblem(
      409,
      'LINKED_TRANSACTION_INVALID',
      'The linked transaction is missing or no longer trusted, so this dispute is read-only.'
    );
  }

  const merchantAccountId =
    event.responseMerchantAccountId ||
    event.resolvedMerchantAccountId ||
    root.responseMerchantAccountId ||
    root.resolvedMerchantAccountId;
  if (
    typeof merchantAccountId !== 'string' ||
    merchantAccountId.trim() === '' ||
    (event.resolvedMerchantAccountId && event.resolvedMerchantAccountId !== merchantAccountId) ||
    (event.responseMerchantAccountId && event.responseMerchantAccountId !== merchantAccountId) ||
    (root.resolvedMerchantAccountId && root.resolvedMerchantAccountId !== merchantAccountId) ||
    (root.responseMerchantAccountId && root.responseMerchantAccountId !== merchantAccountId)
  ) {
    throw new ApiProblem(
      409,
      'DISPUTE_ROUTE_UNVERIFIED',
      'The dispute and linked transaction do not agree on a verified merchant account.'
    );
  }

  let account;
  try {
    account = availableAccount(service, merchantAccountId);
  } catch {
    account = null;
  }
  if (!account) {
    throw new ApiProblem(
      409,
      'MERCHANT_ACCOUNT_INACTIVE',
      'The dispute merchant account is not active in the current catalog.'
    );
  }

  const rootCurrency = normalizeCurrency(root.currency || root.intent?.currency);
  const eventCurrency = normalizeCurrency(event.currency);
  const accountCurrency = normalizeCurrency(account.currency);
  const currencies = [rootCurrency, eventCurrency, accountCurrency].filter(Boolean);
  if (currencies.length === 0 || currencies.some((currency) => currency !== currencies[0])) {
    throw new ApiProblem(
      409,
      'DISPUTE_CURRENCY_UNVERIFIED',
      'The dispute, linked transaction, and merchant account do not agree on a currency.'
    );
  }

  const transactionId = typeof root.braintreeId === 'string'
    ? root.braintreeId.trim()
    : '';
  if (
    transactionId === '' ||
    (event.braintreeId && event.braintreeId !== transactionId)
  ) {
    throw new ApiProblem(
      409,
      'DISPUTE_TRANSACTION_UNVERIFIED',
      'The webhook does not match its linked Braintree transaction.'
    );
  }

  return {
    event,
    root,
    disputeId: String(event.disputeId).trim(),
    transactionId,
    merchantAccountId: merchantAccountId.trim(),
    gatewayMerchantId: state.gatewayMerchantId,
    currency: currencies[0],
  };
}

function assertLiveDispute(dispute, context) {
  const summary = safeDisputeSummary(dispute);
  if (!summary.id || summary.id !== context.disputeId) {
    throw new ApiProblem(
      502,
      'BRAINTREE_RESPONSE_INVALID',
      'Braintree did not return the expected dispute. No action was requested.'
    );
  }
  if (summary.transactionId && summary.transactionId !== context.transactionId) {
    throw new ApiProblem(
      502,
      'DISPUTE_TRANSACTION_MISMATCH',
      'The live dispute belongs to a different transaction. No action was requested.'
    );
  }
  if (summary.merchantAccountId && summary.merchantAccountId !== context.merchantAccountId) {
    throw new ApiProblem(
      502,
      'DISPUTE_ACCOUNT_MISMATCH',
      'The live dispute belongs to a different merchant account. No action was requested.'
    );
  }
  if (summary.currency && summary.currency !== context.currency) {
    throw new ApiProblem(
      502,
      'DISPUTE_CURRENCY_MISMATCH',
      'The live dispute uses a different currency from its linked transaction. No action was requested.'
    );
  }
  return summary;
}

async function findLiveDispute(client, context) {
  const dispute = disputeFrom(await client.findDispute({
    disputeId: context.disputeId,
    merchantAccountId: context.merchantAccountId,
  }));
  assertLiveDispute(dispute, context);
  return dispute;
}

function actionState(dispute) {
  const status = normalizeStatus(dispute?.status);
  const open = status === OPEN_STATUS;
  const unavailableReason = open
    ? null
    : 'Only open disputes can be accepted, receive evidence, or be finalized.';
  return {
    status,
    accept: { allowed: open, reason: unavailableReason },
    evidence: { allowed: open, reason: unavailableReason },
    finalize: { allowed: open, reason: unavailableReason },
  };
}

function activityRows(service, store) {
  const state = safeCatalogState(service);
  const gatewayMerchantId = state?.status === 'ok' ? state.gatewayMerchantId : null;
  return disputeActivityRows(store.list(), gatewayMerchantId);
}

function sendProblem(res, problem) {
  const safe = problem instanceof ApiProblem
    ? problem
    : new ApiProblem(
        502,
        'BRAINTREE_REQUEST_FAILED',
        'Braintree did not return a usable dispute result. Check the Sandbox Control Panel before retrying.'
      );
  return res.status(safe.status).json(redact({
    success: false,
    error: { code: safe.code, message: safe.message },
    ...safe.details,
  }));
}

function validateActionInput(action, rawBody) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? rawBody
    : {};
  const allowedFields = action === 'evidence' ? new Set(['evidence']) : new Set(['confirm']);
  const unexpected = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unexpected.length > 0) {
    throw new ApiProblem(
      400,
      'UNEXPECTED_ACTION_INPUT',
      'Dispute and merchant account identifiers are resolved from the signed webhook event.'
    );
  }

  if (action === 'accept' || action === 'finalize') {
    if (body.confirm !== true) {
      throw new ApiProblem(
        400,
        'CONFIRMATION_REQUIRED',
        `Explicit confirmation is required before ${action === 'accept' ? 'accepting' : 'finalizing'} a dispute.`
      );
    }
    return {};
  }

  const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : '';
  if (evidence === '' || evidence.length > MAX_EVIDENCE_LENGTH) {
    throw new ApiProblem(
      400,
      'INVALID_EVIDENCE',
      `Evidence must contain between 1 and ${MAX_EVIDENCE_LENGTH} characters.`
    );
  }
  return { evidence };
}

function appendActionAudit(store, context, action, liveDispute, success) {
  const summary = safeDisputeSummary(liveDispute);
  return store.append({
    type: 'dispute_action',
    stage: 4,
    action,
    endpoint: `disputes/${action}`,
    scenarioId: context.root.scenarioId,
    intent: context.root.intent,
    resolvedMerchantAccountId: context.merchantAccountId,
    responseMerchantAccountId: summary.merchantAccountId || context.merchantAccountId,
    verified:
      (!summary.merchantAccountId || summary.merchantAccountId === context.merchantAccountId) &&
      (!summary.transactionId || summary.transactionId === context.transactionId),
    amount: summary.amountDisputed || context.event.amount || null,
    currency: summary.currency || context.currency,
    outcome: success ? 'succeeded' : 'failed',
    transactionStatus: null,
    braintreeId: context.transactionId,
    originalBraintreeId: context.transactionId,
    relatedEventId: context.event.id,
    disputeId: context.disputeId,
    disputeStatus: summary.status,
    disputeReason: summary.reason || context.event.disputeReason || null,
    request: {
      action,
      ...(action === 'evidence' ? { evidenceProvided: true } : {}),
    },
    response: { success: Boolean(success), dispute: summary },
  });
}

function createDemoDisputesRouter({
  gatewayClient,
  getClient = getGatewayClient,
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
  logger = console,
} = {}) {
  if (!gatewayClient && typeof getClient !== 'function') {
    throw new TypeError('A Braintree gateway client is required');
  }
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  if (
    !store ||
    typeof store.get !== 'function' ||
    typeof store.list !== 'function' ||
    typeof store.append !== 'function'
  ) {
    throw new TypeError('A readable and writable event store is required');
  }

  const router = express.Router();
  const gateway = () => gatewayClient || getClient();
  const catalog = () => catalogService || getCatalogService();
  const actionsInProgress = new Set();

  router.get('/', (req, res) => {
    const rows = activityRows(catalog(), store);
    return res.render('demo-disputes', {
      layout: false,
      title: 'Disputes · Braintree Routing Lab',
      initialDisputeCount: rows.length,
    });
  });

  router.get('/:eventId/status', async (req, res) => {
    try {
      const context = requireDisputeContext(req.params.eventId, catalog(), store);
      const dispute = await findLiveDispute(gateway(), context);
      return res.json({
        success: true,
        eventId: context.event.id,
        dispute: safeDisputeSummary(dispute),
        actions: actionState(dispute),
      });
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        logger.error('Stage 4 dispute status error:', error?.name ?? 'Error');
      }
      return sendProblem(res, error);
    }
  });

  router.post('/:eventId/actions/:action', async (req, res) => {
    let context;
    let action;
    let operationRequested = false;
    let operationConfirmed = false;
    let actionLockKey = null;
    let actionLockAcquired = false;
    try {
      action = normalizeStatus(req.params.action);
      if (!ACTIONS.has(action)) {
        throw new ApiProblem(
          404,
          'ACTION_NOT_FOUND',
          'Choose accept, evidence, or finalize.'
        );
      }
      const input = validateActionInput(action, req.body);
      context = requireDisputeContext(req.params.eventId, catalog(), store);
      // Webhook retries and status transitions can create more than one local
      // event for the same Braintree dispute. Lock the gateway identity rather
      // than the selected event so those aliases cannot mutate concurrently.
      actionLockKey = JSON.stringify([
        context.gatewayMerchantId,
        context.disputeId,
      ]);
      if (actionsInProgress.has(actionLockKey)) {
        throw new ApiProblem(
          409,
          'DISPUTE_ACTION_IN_PROGRESS',
          'Another action for this dispute is still in progress. Wait for its live status before trying anything else.',
          { retrySafe: true }
        );
      }
      actionsInProgress.add(actionLockKey);
      actionLockAcquired = true;
      const client = gateway();
      const before = await findLiveDispute(client, context);
      const actions = actionState(before);
      if (!actions[action]?.allowed) {
        throw new ApiProblem(
          409,
          'ACTION_NOT_ALLOWED',
          actions[action]?.reason || 'That dispute action is unavailable.',
          { dispute: safeDisputeSummary(before), actions }
        );
      }

      const request = {
        disputeId: context.disputeId,
        merchantAccountId: context.merchantAccountId,
      };
      operationRequested = true;
      let result;
      if (action === 'accept') result = await client.acceptDispute(request);
      if (action === 'evidence') {
        result = await client.addDisputeTextEvidence({
          ...request,
          content: input.evidence,
        });
      }
      if (action === 'finalize') result = await client.finalizeDispute(request);

      if (result?.success === false) {
        try {
          appendActionAudit(store, context, action, before, false);
        } catch (auditError) {
          logger.error('Stage 4 failed-action audit error:', auditError?.name ?? 'Error');
        }
        throw new ApiProblem(
          422,
          'BRAINTREE_DISPUTE_ACTION_FAILED',
          result.message || 'Braintree did not complete the dispute action.'
        );
      }
      if (result?.success !== true) {
        throw new Error('Braintree returned no explicit dispute-action result.');
      }
      operationConfirmed = true;

      const after = await findLiveDispute(client, context);
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        auditEventId = appendActionAudit(store, context, action, after, true).id;
      } catch (auditError) {
        logger.error('Stage 4 dispute action audit error:', auditError?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree returned a result, but the local audit event could not be saved. Do not retry; inspect the Sandbox Control Panel.',
        };
      }

      return res.json({
        success: true,
        action,
        dispute: safeDisputeSummary(after),
        actions: actionState(after),
        auditEventId,
        audit,
        // A confirmed gateway mutation is never safe to replay automatically,
        // even when the local audit write succeeded.
        retrySafe: false,
      });
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        logger.error('Stage 4 dispute action error:', error?.name ?? 'Error');
      }
      if (operationConfirmed && context) {
        return sendProblem(res, new ApiProblem(
          502,
          'BRAINTREE_ACTION_OUTCOME_UNVERIFIED',
          'Braintree completed the dispute action, but its live result could not be verified. Do not retry; inspect the Sandbox Control Panel first.',
          { retrySafe: false, action, relatedEventId: context.event.id }
        ));
      }
      if (!(error instanceof ApiProblem) && operationRequested && context) {
        return sendProblem(res, new ApiProblem(
          502,
          'BRAINTREE_ACTION_OUTCOME_UNKNOWN',
          'The dispute action outcome is unknown. Do not retry; inspect the Sandbox Control Panel first.',
          { retrySafe: false, action, relatedEventId: context.event.id }
        ));
      }
      return sendProblem(res, error);
    } finally {
      if (actionLockAcquired) actionsInProgress.delete(actionLockKey);
    }
  });

  return router;
}

const router = createDemoDisputesRouter();
router.ApiProblem = ApiProblem;
router.actionState = actionState;
router.activityRows = activityRows;
router.createDemoDisputesRouter = createDemoDisputesRouter;
router.requireDisputeContext = requireDisputeContext;
router.safeDisputeSummary = safeDisputeSummary;

module.exports = router;
module.exports.ApiProblem = ApiProblem;
module.exports.actionState = actionState;
module.exports.activityRows = activityRows;
module.exports.createDemoDisputesRouter = createDemoDisputesRouter;
module.exports.requireDisputeContext = requireDisputeContext;
module.exports.safeDisputeSummary = safeDisputeSummary;
