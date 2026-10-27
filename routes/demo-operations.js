'use strict';

const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const {
  buildSandboxTransactionUrl,
  summarizeGatewayResult,
  summarizeTransaction,
} = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const eventStore = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const {
  subtractAmounts,
  validateActionAmount,
} = require('../lib/transactions/money');

const ACTIONS = new Set(['capture', 'void', 'settle', 'refund']);
const CAPTURE_STATUSES = new Set(['authorized']);
const VOID_STATUSES = new Set([
  'authorized',
  'submitted_for_settlement',
  'settlement_pending',
]);
const SETTLE_STATUSES = new Set(['submitted_for_settlement']);
const REFUND_STATUSES = new Set(['settling', 'settled']);

class ApiProblem extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function transactionFrom(value) {
  if (value?.transaction && typeof value.transaction === 'object') {
    return value.transaction;
  }
  return value && typeof value === 'object' ? value : null;
}

function normalizeGatewayResult(value) {
  if (value && typeof value.success === 'boolean') return value;
  const transaction = transactionFrom(value);
  return {
    success: Boolean(transaction?.id),
    transaction,
    message: transaction?.id ? null : 'Braintree did not return a transaction.',
  };
}

function normalizeStatus(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[ -]+/g, '_')
    : '';
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

function requireRootContext(eventId, service, store) {
  if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId)) {
    throw new ApiProblem(400, 'INVALID_EVENT_ID', 'Choose a valid transaction audit event.');
  }

  const event = store.get(eventId);
  if (!event) {
    throw new ApiProblem(404, 'EVENT_NOT_FOUND', 'That transaction audit event was not found.');
  }
  if (event.type !== 'transaction' || event.relatedEventId) {
    throw new ApiProblem(
      409,
      'ROOT_TRANSACTION_REQUIRED',
      'Actions can only start from an original transaction event, not a route or follow-up event.'
    );
  }

  let state;
  try {
    state = service.getState();
  } catch {
    state = null;
  }
  if (state?.status !== 'ok' || typeof state.gatewayMerchantId !== 'string') {
    throw new ApiProblem(
      503,
      'CATALOG_UNAVAILABLE',
      'Merchant account discovery is unavailable. Refresh the gateway catalog before operating on a transaction.'
    );
  }
  if (!event.gatewayMerchantId) {
    throw new ApiProblem(
      409,
      'LEGACY_EVENT_READ_ONLY',
      'This legacy event has no gateway identity and is read-only.'
    );
  }
  if (event.gatewayMerchantId !== state.gatewayMerchantId) {
    throw new ApiProblem(
      409,
      'HISTORICAL_GATEWAY_READ_ONLY',
      'This transaction belongs to a different gateway configuration and is read-only.'
    );
  }
  if (typeof event.braintreeId !== 'string' || event.braintreeId.trim() === '') {
    throw new ApiProblem(
      409,
      'TRANSACTION_ID_UNAVAILABLE',
      'This event does not contain a Braintree transaction ID.'
    );
  }

  const resolvedMerchantAccountId = event.resolvedMerchantAccountId;
  const responseMerchantAccountId = event.responseMerchantAccountId;
  const merchantAccountId = responseMerchantAccountId || resolvedMerchantAccountId;
  if (
    typeof merchantAccountId !== 'string' ||
    merchantAccountId.trim() === '' ||
    (resolvedMerchantAccountId && responseMerchantAccountId &&
      resolvedMerchantAccountId !== responseMerchantAccountId) ||
    event.verified !== true
  ) {
    throw new ApiProblem(
      409,
      'UNVERIFIED_ROUTE_READ_ONLY',
      'The original route was not verified, so this transaction is read-only.'
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
      'The original merchant account is no longer active in the discovered catalog. Refresh and review before continuing.'
    );
  }

  const currency = typeof event.currency === 'string'
    ? event.currency.trim().toUpperCase()
    : typeof event.intent?.currency === 'string'
      ? event.intent.currency.trim().toUpperCase()
      : '';
  if (!/^[A-Z]{3}$/.test(currency) || account.currency !== currency) {
    throw new ApiProblem(
      409,
      'PERSISTED_ROUTE_INVALID',
      'The persisted currency does not match the original merchant account. This transaction is read-only.'
    );
  }

  return {
    root: event,
    account,
    currency,
    merchantAccountId,
    transactionId: event.braintreeId.trim(),
    gatewayMerchantId: state.gatewayMerchantId,
  };
}

function assertLiveRoute(transaction, context, label = 'transaction') {
  if (!transaction || typeof transaction !== 'object') {
    throw new ApiProblem(
      502,
      'BRAINTREE_RESPONSE_INVALID',
      `Braintree did not return the ${label}. Do not retry an action until the Sandbox Control Panel has been checked.`
    );
  }

  const actualMerchantAccountId = transaction.merchantAccountId ?? null;
  const actualCurrency = transaction.currencyIsoCode ?? null;
  if (
    actualMerchantAccountId !== context.merchantAccountId ||
    actualCurrency !== context.currency
  ) {
    throw new ApiProblem(
      502,
      'ROUTE_VERIFICATION_FAILED',
      `The live ${label} does not match the original merchant account and currency. No further action was requested.`,
      {
        verification: {
          passed: false,
          expectedMerchantAccountId: context.merchantAccountId,
          actualMerchantAccountId,
          expectedCurrency: context.currency,
          actualCurrency,
        },
      }
    );
  }
  return transaction;
}

async function findLiveTransaction(gateway, context, transactionId = context.transactionId) {
  const found = await gateway.findTransaction({
    merchantAccountId: context.merchantAccountId,
    transactionId,
  });
  return assertLiveRoute(transactionFrom(found), context, 'transaction');
}

async function refundableBalance(gateway, context, transaction) {
  const refundIds = Array.isArray(transaction.refundIds)
    ? [...new Set(transaction.refundIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  const refundAmounts = [];

  for (const refundId of refundIds) {
    const refund = await findLiveTransaction(gateway, context, refundId.trim());
    refundAmounts.push(refund.amount);
  }

  return {
    ...subtractAmounts(transaction.amount, refundAmounts, context.currency),
    refundCount: refundAmounts.length,
  };
}

async function buildActionState(gateway, context, transaction) {
  const status = normalizeStatus(transaction.status);
  let refundable = null;
  let refundReason = 'Refunds require a settling or settled transaction.';

  if (REFUND_STATUSES.has(status)) {
    refundable = await refundableBalance(gateway, context, transaction);
    refundReason = refundable.units > 0n
      ? null
      : 'The transaction has already been fully refunded.';
  }

  return {
    status,
    capture: {
      allowed: CAPTURE_STATUSES.has(status),
      maximumAmount: CAPTURE_STATUSES.has(status) ? transaction.amount : null,
      reason: CAPTURE_STATUSES.has(status)
        ? null
        : 'Capture requires an authorized transaction.',
    },
    void: {
      allowed: VOID_STATUSES.has(status),
      reason: VOID_STATUSES.has(status)
        ? null
        : 'Void is unavailable in the current transaction state.',
    },
    settle: {
      allowed: SETTLE_STATUSES.has(status),
      reason: SETTLE_STATUSES.has(status)
        ? null
        : 'Sandbox settlement requires a submitted-for-settlement transaction.',
    },
    refund: {
      allowed: Boolean(refundable && refundable.units > 0n),
      maximumAmount: refundable?.amount ?? null,
      refundCount: refundable?.refundCount ?? 0,
      reason: refundReason,
    },
  };
}

function sendProblem(res, problem) {
  const safe = problem instanceof ApiProblem
    ? problem
    : new ApiProblem(
        502,
        'BRAINTREE_REQUEST_FAILED',
        'Braintree did not return a usable result. Check the Sandbox Control Panel before retrying.'
      );
  return res.status(safe.status).json(redact({
    success: false,
    error: { code: safe.code, message: safe.message },
    ...safe.details,
  }));
}

function actionVerification(transaction, context) {
  return {
    passed:
      transaction?.merchantAccountId === context.merchantAccountId &&
      transaction?.currencyIsoCode === context.currency,
    expectedMerchantAccountId: context.merchantAccountId,
    actualMerchantAccountId: transaction?.merchantAccountId ?? null,
    expectedCurrency: context.currency,
    actualCurrency: transaction?.currencyIsoCode ?? null,
  };
}

function appendActionEvent(store, context, action, amount, result, verification, outcome) {
  const transaction = result?.transaction ?? null;
  return store.append({
    type: 'transaction_action',
    stage: 2,
    action,
    endpoint: `transactions/actions/${action}`,
    scenarioId: context.root.scenarioId,
    intent: context.root.intent,
    resolvedMerchantAccountId: context.merchantAccountId,
    responseMerchantAccountId: transaction?.merchantAccountId ?? null,
    verified: verification?.passed === true,
    paymentMethodType:
      transaction?.paymentInstrumentType ?? context.root.paymentMethodType ?? null,
    amount: amount ?? transaction?.amount ?? context.root.amount,
    currency: transaction?.currencyIsoCode ?? context.currency,
    outcome,
    transactionStatus: transaction?.status ?? null,
    braintreeId: transaction?.id ?? null,
    relatedEventId: context.root.id,
    originalBraintreeId: context.transactionId,
    request: { action, ...(amount ? { amount } : {}) },
    response: summarizeGatewayResult(result),
    verification,
  });
}

function createDemoOperationsRouter({
  gatewayClient,
  getClient = getGatewayClient,
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
  merchantId = process.env.MERCHANT_ID,
  logger = console,
} = {}) {
  if (!gatewayClient && typeof getClient !== 'function') {
    throw new TypeError('A gateway client is required');
  }
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  if (!store || typeof store.get !== 'function' || typeof store.append !== 'function') {
    throw new TypeError('A readable and writable event store is required');
  }

  const router = express.Router();
  const gateway = () => gatewayClient || getClient();
  const catalog = () => catalogService || getCatalogService();

  router.get('/:eventId/status', async (req, res) => {
    try {
      const context = requireRootContext(req.params.eventId, catalog(), store);
      const transaction = await findLiveTransaction(gateway(), context);
      const actions = await buildActionState(gateway(), context, transaction);
      return res.json({
        success: true,
        eventId: context.root.id,
        transaction: summarizeTransaction(transaction),
        actions,
        controlPanelUrl: buildSandboxTransactionUrl(
          context.gatewayMerchantId || merchantId,
          context.transactionId
        ),
      });
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        logger.error('Stage 2 transaction status error:', error?.name ?? 'Error');
      }
      return sendProblem(res, error);
    }
  });

  router.post('/:eventId/actions/:action', async (req, res) => {
    let context;
    let action;
    let operationAmount;
    let liveTransaction;
    let operationRequested = false;
    try {
      action = typeof req.params.action === 'string'
        ? req.params.action.trim().toLowerCase()
        : '';
      if (!ACTIONS.has(action)) {
        throw new ApiProblem(404, 'ACTION_NOT_FOUND', 'Choose capture, void, settle, or refund.');
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
      const unexpectedFields = Object.keys(body).filter((key) => key !== 'amount');
      if (unexpectedFields.length > 0) {
        throw new ApiProblem(
          400,
          'UNEXPECTED_ACTION_INPUT',
          'The server accepts only an optional amount; transaction and account identifiers come from the audit event.'
        );
      }

      context = requireRootContext(req.params.eventId, catalog(), store);
      const client = gateway();
      // This refresh is deliberately inside the POST handler and immediately
      // precedes the state check for every operation.
      liveTransaction = await findLiveTransaction(client, context);
      const actions = await buildActionState(client, context, liveTransaction);
      const selectedState = actions[action];
      if (!selectedState?.allowed) {
        throw new ApiProblem(
          409,
          'ACTION_NOT_ALLOWED',
          selectedState?.reason || 'That action is unavailable in the current transaction state.',
          { transaction: summarizeTransaction(liveTransaction), actions }
        );
      }

      const suppliedAmount = body.amount == null ? '' : String(body.amount).trim();
      if (suppliedAmount) {
        if (!['capture', 'refund'].includes(action)) {
          throw new ApiProblem(
            400,
            'AMOUNT_NOT_ALLOWED',
            'An amount is only accepted for capture or refund.'
          );
        }
        const validation = validateActionAmount(
          suppliedAmount,
          selectedState.maximumAmount,
          context.currency
        );
        if (!validation.valid) {
          throw new ApiProblem(400, validation.code, validation.message, {
            maximumAmount: selectedState.maximumAmount,
            currency: context.currency,
          });
        }
        operationAmount = validation.amount;
      }
      // Always send the currently calculated refundable remainder for a full
      // refund. Omitting an amount after an earlier partial refund can be
      // ambiguous across gateway/API behavior, while the explicit remainder
      // is deterministic and remains bounded by the live refund history.
      if (action === 'refund' && !operationAmount) {
        operationAmount = selectedState.maximumAmount;
      }

      const request = {
        merchantAccountId: context.merchantAccountId,
        transactionId: context.transactionId,
        ...(operationAmount ? { amount: operationAmount } : {}),
      };
      let rawResult;
      operationRequested = true;
      if (action === 'capture') rawResult = await client.captureTransaction(request);
      if (action === 'void') rawResult = await client.voidTransaction(request);
      if (action === 'settle') rawResult = await client.settleTransaction(request);
      if (action === 'refund') rawResult = await client.refundTransaction(request);

      const result = normalizeGatewayResult(rawResult);
      const transaction = result.transaction;
      const verification = actionVerification(transaction, context);
      const outcome = result.success === true && verification.passed
        ? 'succeeded'
        : 'failed';
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        const event = appendActionEvent(
          store,
          context,
          action,
          operationAmount,
          result,
          verification,
          outcome
        );
        auditEventId = event.id;
      } catch (auditError) {
        logger.error('Stage 2 action audit persistence error:', auditError?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree returned an action result, but the local audit event could not be saved. Do not retry; inspect the transaction in the Sandbox Control Panel first.',
        };
      }

      const payload = {
        success: result.success === true && verification.passed,
        action,
        relatedEventId: context.root.id,
        braintreeResult: summarizeGatewayResult(result),
        verification,
        controlPanelUrl: buildSandboxTransactionUrl(
          context.gatewayMerchantId || merchantId,
          transaction?.id || context.transactionId
        ),
        auditEventId,
        audit,
        retrySafe: audit.persisted !== false,
      };
      if (transaction && !verification.passed) {
        payload.retrySafe = false;
        return sendProblem(
          res,
          new ApiProblem(
            502,
            'ROUTE_VERIFICATION_FAILED',
            'Braintree returned the action on a different merchant account or currency. Do not retry; inspect both transactions in the Sandbox Control Panel.',
            payload
          )
        );
      }
      if (result.success !== true) {
        return sendProblem(
          res,
          new ApiProblem(
            422,
            'BRAINTREE_ACTION_FAILED',
            result.message || 'Braintree did not complete the requested action.',
            payload
          )
        );
      }
      return res.json(payload);
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        logger.error('Stage 2 transaction action error:', error?.name ?? 'Error');

        // A thrown SDK/network error can be ambiguous: the operation may have
        // reached Braintree. Record that uncertainty when possible.
        if (context && action) {
          try {
            store.append({
              type: 'transaction_action',
              stage: 2,
              action,
              endpoint: `transactions/actions/${action}`,
              scenarioId: context.root.scenarioId,
              intent: context.root.intent,
              resolvedMerchantAccountId: context.merchantAccountId,
              responseMerchantAccountId: null,
              verified: false,
              paymentMethodType: context.root.paymentMethodType,
              amount: operationAmount ?? context.root.amount,
              currency: context.currency,
              outcome: 'gateway_error',
              braintreeId: null,
              relatedEventId: context.root.id,
              originalBraintreeId: context.transactionId,
              request: { action, ...(operationAmount ? { amount: operationAmount } : {}) },
              error: { name: error?.name ?? 'Error', code: error?.code ?? null },
            });
          } catch (auditError) {
            logger.error('Stage 2 ambiguous action audit error:', auditError?.name ?? 'Error');
          }
        }
      }
      if (!(error instanceof ApiProblem) && operationRequested && context) {
        return sendProblem(
          res,
          new ApiProblem(
            502,
            'BRAINTREE_ACTION_OUTCOME_UNKNOWN',
            'Braintree did not return a usable action result. Do not retry; inspect the transaction in the Sandbox Control Panel first.',
            {
              retrySafe: false,
              action,
              relatedEventId: context.root.id,
              controlPanelUrl: buildSandboxTransactionUrl(
                context.gatewayMerchantId || merchantId,
                context.transactionId
              ),
            }
          )
        );
      }
      return sendProblem(res, error);
    }
  });

  return router;
}

const router = createDemoOperationsRouter();
router.ApiProblem = ApiProblem;
router.buildActionState = buildActionState;
router.createDemoOperationsRouter = createDemoOperationsRouter;
router.requireRootContext = requireRootContext;

module.exports = router;
module.exports.ApiProblem = ApiProblem;
module.exports.buildActionState = buildActionState;
module.exports.createDemoOperationsRouter = createDemoOperationsRouter;
module.exports.requireRootContext = requireRootContext;
