'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const {
  buildSandboxTransactionUrl,
  summarizeGatewayResult,
  verifyMerchantAccount,
} = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const {
  validateCanonicalAmount,
  validateDemoPaymentAmount,
} = require('../lib/currency');
const { buildDemoScenarios } = require('../lib/demo/scenarios');
const eventStore = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const {
  DEFAULT_PAYMENT_METHODS,
  IMPLEMENTED_PAYMENT_METHODS,
  normalizePaymentMethod,
  paymentMethodFromInstrumentType,
  paymentMethodFromNonce,
} = require('../lib/payment-methods');
const { resolveRoute } = require('../lib/routing/resolve-route');
const { verifyThreeDSecure } = require('../lib/three-d-secure');

const ALLOWED_PAYMENT_TYPES = new Set(['one_time', 'recurring']);
const ALLOWED_TRANSACTION_MODES = new Set([
  'submit_for_settlement',
  'authorize_only',
]);
const ALLOWED_EXPECTED_OUTCOMES = new Set([
  'approved',
  'processor_declined',
  'gateway_rejected',
]);

function normalizeDemoChoice(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function normalizeTransactionMode(value) {
  return normalizeDemoChoice(
    value,
    ALLOWED_TRANSACTION_MODES,
    'submit_for_settlement'
  );
}

function normalizeExpectedOutcome(value) {
  return normalizeDemoChoice(value, ALLOWED_EXPECTED_OUTCOMES, 'approved');
}

function normalizeRequestedPaymentMethod(value) {
  if (value === undefined || value === null) return 'card';
  if (typeof value === 'string' && value.trim() === '') return 'card';
  return normalizePaymentMethod(value);
}

function normalizeScenarioId(value, catalog = []) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'manual') return normalized;

  try {
    const knownScenarioIds = new Set(
      buildDemoScenarios(catalog).map((scenario) => scenario.id)
    );
    return knownScenarioIds.has(normalized) ? normalized : 'manual';
  } catch {
    return 'manual';
  }
}

function normalizeAmount(value, currency) {
  try {
    const result = validateCanonicalAmount(value, currency);
    return result.valid ? result.amount : null;
  } catch {
    return null;
  }
}

function toPublicDecision(decision) {
  const currency = /^[A-Z]{3}$/.test(decision.intent.currency || '')
    ? decision.intent.currency
    : null;
  const paymentType = ALLOWED_PAYMENT_TYPES.has(decision.intent.paymentType)
    ? decision.intent.paymentType
    : null;

  return {
    matched: decision.matched,
    intent: { currency, paymentType },
    account: decision.account,
    reason: decision.reason,
    trace: decision.trace,
  };
}

function buildSafeRequest(body, decision, amount, catalog) {
  const intent = toPublicDecision(decision).intent;
  return redact({
    scenarioId: normalizeScenarioId(body?.scenarioId, catalog),
    currency: intent.currency,
    paymentType: intent.paymentType,
    ...(amount ? { amount } : {}),
    paymentMethod: normalizeRequestedPaymentMethod(body?.paymentMethod),
    transactionMode: normalizeTransactionMode(body?.transactionMode),
    expectedOutcome: normalizeExpectedOutcome(body?.expectedOutcome),
  });
}

function getPaymentMethodProblem(decision, paymentMethod) {
  if (!paymentMethod || !IMPLEMENTED_PAYMENT_METHODS.has(paymentMethod)) {
    return {
      status: 400,
      code: 'INVALID_PAYMENT_METHOD',
      message: 'Choose Card or PayPal.',
    };
  }

  if (!decision.matched) return null;
  const allowedMethods = Array.isArray(decision.account?.paymentMethods)
    ? decision.account.paymentMethods
    : DEFAULT_PAYMENT_METHODS;
  if (!allowedMethods.includes(paymentMethod)) {
    return {
      status: 422,
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      message: `${paymentMethod === 'paypal' ? 'PayPal' : 'Card'} is not enabled on the selected route. Choose an available method or another routing intent.`,
    };
  }

  return null;
}

function verifyTransactionCurrency(result, expectedCurrency) {
  const actualCurrency = typeof result?.transaction?.currencyIsoCode === 'string'
    ? result.transaction.currencyIsoCode.trim().toUpperCase()
    : null;
  const normalizedExpectedCurrency = typeof expectedCurrency === 'string'
    ? expectedCurrency.trim().toUpperCase()
    : null;
  const passed = Boolean(
    normalizedExpectedCurrency && actualCurrency === normalizedExpectedCurrency
  );

  return {
    passed,
    expectedCurrency: normalizedExpectedCurrency,
    actualCurrency,
    explanation: passed
      ? 'Braintree returned the currency selected by the routing engine.'
      : 'The currency returned by Braintree did not match the selected route.',
  };
}

function verifyTransactionPaymentMethod(result, expectedPaymentMethod) {
  const actualInstrumentType = typeof result?.transaction?.paymentInstrumentType === 'string'
    ? result.transaction.paymentInstrumentType.trim().toLowerCase()
    : null;
  const actualPaymentMethod = paymentMethodFromInstrumentType(actualInstrumentType);
  const passed = Boolean(
    expectedPaymentMethod && actualPaymentMethod === expectedPaymentMethod
  );

  return {
    passed,
    expectedPaymentMethod,
    actualPaymentMethod,
    actualInstrumentType,
    explanation: passed
      ? 'Braintree returned the selected payment method.'
      : 'The payment method returned by Braintree did not match the selected method.',
  };
}

function appendRouteEvent(store, endpoint, safeRequest, decision) {
  const route = toPublicDecision(decision);
  return store.append({
    type: 'route_resolution',
    stage: route.intent.paymentType === 'recurring' ? 3 : 2,
    endpoint,
    scenarioId: safeRequest.scenarioId,
    intent: route.intent,
    resolvedMerchantAccountId: decision.account?.merchantAccountId ?? null,
    threeDSecurePolicy: decision.account?.threeDSecurePolicy ?? null,
    paymentMethodType: safeRequest.paymentMethod,
    currency: route.intent.currency,
    transactionMode: safeRequest.transactionMode,
    expectedOutcome: safeRequest.expectedOutcome,
    request: safeRequest,
    outcome: decision.matched ? 'matched' : 'no_route',
    route,
  });
}

function appendThreeDSecureBlockedEvent(
  store,
  endpoint,
  safeRequest,
  decision,
  verification
) {
  return store.append({
    type: 'three_d_secure',
    stage: 6,
    endpoint,
    scenarioId: safeRequest.scenarioId,
    intent: toPublicDecision(decision).intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    verified: false,
    paymentMethodType: safeRequest.paymentMethod,
    threeDSecurePolicy: verification.policy,
    threeDSecureStatus: verification.status,
    liabilityShiftPossible: verification.liabilityShiftPossible,
    liabilityShifted: verification.liabilityShifted,
    amount: safeRequest.amount ?? null,
    currency: decision.intent.currency,
    outcome: 'blocked',
    request: safeRequest,
    route: toPublicDecision(decision),
    threeDSecureVerification: verification,
  });
}

function detectGatewayOutcome(result) {
  const transaction = result?.transaction;
  const status = typeof transaction?.status === 'string'
    ? transaction.status.trim().toLowerCase()
    : '';
  const rejectionReason = transaction?.gatewayRejectionReason;
  const responseCode = Number.parseInt(transaction?.processorResponseCode, 10);

  if (
    status === 'gateway_rejected' ||
    (typeof rejectionReason === 'string' && rejectionReason.trim() !== '')
  ) {
    return 'gateway_rejected';
  }
  if (
    status === 'processor_declined' ||
    (Number.isInteger(responseCode) && responseCode >= 2000 && responseCode <= 2999)
  ) {
    return 'processor_declined';
  }
  if (result?.success === true) return 'approved';
  return 'failed';
}

function sendProblem(res, status, code, message, details = {}) {
  return res.status(status).json({
    success: false,
    error: { code, message },
    ...details,
  });
}

function safeCatalogState(service) {
  try {
    return service.getState();
  } catch {
    return {
      status: 'failed',
      gatewayMerchantId: null,
      discoveredAt: null,
      error: null,
      warnings: [],
      accounts: [],
    };
  }
}

function sendCatalogUnavailable(res, service) {
  const state = safeCatalogState(service);
  return sendProblem(
    res,
    503,
    'CATALOG_UNAVAILABLE',
    state.error?.message ||
      'Merchant account discovery is unavailable. Refresh the connected Sandbox accounts before routing a payment.',
    { catalog: { status: state.status, discoveredAt: state.discoveredAt || null } }
  );
}

function availableCatalog(service) {
  const state = safeCatalogState(service);
  if (state.status !== 'ok') return null;
  try {
    return service.getMerchantAccounts();
  } catch {
    return null;
  }
}

function resolveRequest(body, catalog) {
  return resolveRoute(
    { currency: body?.currency, paymentType: body?.paymentType },
    catalog
  );
}

function isLocallyBlockedGatewayError(error) {
  return ['CATALOG_UNAVAILABLE', 'UNKNOWN_MERCHANT_ACCOUNT'].includes(error?.code);
}

function createDemoApiRouter({
  gatewayClient,
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
  merchantId = process.env.BRAINTREE_MERCHANT_ID || process.env.MERCHANT_ID,
  now = () => Date.now(),
  generateId = () => crypto.randomUUID(),
  logger = console,
} = {}) {
  const router = express.Router();
  const gateway = () => gatewayClient || getGatewayClient();
  const catalog = () => catalogService || getCatalogService();

  router.post('/catalog/refresh', async (req, res) => {
    const service = catalog();
    let state;
    try {
      state = await service.refresh();
    } catch {
      return sendCatalogUnavailable(res, service);
    }
    if (state.status !== 'ok') return sendCatalogUnavailable(res, service);

    return res.json({
      success: true,
      catalog: {
        status: state.status,
        gatewayMerchantId: state.gatewayMerchantId,
        discoveredAt: state.discoveredAt,
        accountCount: state.accounts.length,
        warnings: state.warnings,
      },
    });
  });

  router.post('/route-preview', (req, res, next) => {
    const service = catalog();
    const accounts = availableCatalog(service);
    if (!accounts) return sendCatalogUnavailable(res, service);
    try {
      const decision = resolveRequest(req.body, accounts);
      const safeRequest = buildSafeRequest(req.body, decision, undefined, accounts);
      const event = appendRouteEvent(store, 'route-preview', safeRequest, decision);
      const paymentMethodProblem = getPaymentMethodProblem(
        decision,
        safeRequest.paymentMethod
      );
      if (paymentMethodProblem) {
        return sendProblem(
          res,
          paymentMethodProblem.status,
          paymentMethodProblem.code,
          paymentMethodProblem.message,
          {
            request: safeRequest,
            route: toPublicDecision(decision),
            auditEventId: event.id,
          }
        );
      }
      return res.json({
        success: true,
        request: safeRequest,
        route: toPublicDecision(decision),
        auditEventId: event.id,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/client-token', async (req, res, next) => {
    const service = catalog();
    const accounts = availableCatalog(service);
    if (!accounts) return sendCatalogUnavailable(res, service);

    let decision;
    let safeRequest;
    try {
      decision = resolveRequest(req.body, accounts);
      safeRequest = buildSafeRequest(req.body, decision, undefined, accounts);
    } catch (error) {
      return next(error);
    }

    try {
      appendRouteEvent(store, 'client-token', safeRequest, decision);
    } catch (error) {
      logger.error('Stage 2 route audit persistence error:', error?.name ?? 'Error');
      return sendProblem(
        res,
        503,
        'AUDIT_PERSISTENCE_FAILED',
        'The route was resolved, but its local audit event could not be saved. No client authorization was requested.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          audit: { persisted: false },
          retrySafe: true,
        }
      );
    }

    if (!ALLOWED_PAYMENT_TYPES.has(decision.intent.paymentType)) {
      return sendProblem(res, 400, 'INVALID_PAYMENT_TYPE', 'Choose one-time or recurring.');
    }
    if (!decision.matched) {
      return sendProblem(res, 422, 'NO_ROUTE', decision.reason, {
        request: safeRequest,
        route: toPublicDecision(decision),
      });
    }
    const paymentMethodProblem = getPaymentMethodProblem(
      decision,
      safeRequest.paymentMethod
    );
    if (paymentMethodProblem) {
      return sendProblem(
        res,
        paymentMethodProblem.status,
        paymentMethodProblem.code,
        paymentMethodProblem.message,
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          retrySafe: true,
        }
      );
    }
    try {
      const clientToken = await gateway().generateClientToken({
        merchantAccountId: decision.account.merchantAccountId,
      });
      return res.json({
        success: true,
        clientToken,
        request: safeRequest,
        route: toPublicDecision(decision),
      });
    } catch (error) {
      if (isLocallyBlockedGatewayError(error)) {
        return sendProblem(
          res,
          503,
          'CATALOG_UNAVAILABLE',
          'The selected merchant account is no longer active in the current discovery result. Refresh accounts before retrying.',
          { request: safeRequest, route: toPublicDecision(decision) }
        );
      }
      return sendProblem(
        res,
        502,
        'BRAINTREE_REQUEST_FAILED',
        'Braintree could not create the sandbox client authorization. Try again or check the server configuration.',
        { request: safeRequest, route: toPublicDecision(decision) }
      );
    }
  });

  router.post('/payments/one-time', async (req, res, next) => {
    const service = catalog();
    const accounts = availableCatalog(service);
    if (!accounts) return sendCatalogUnavailable(res, service);

    let decision;
    let amount;
    let amountValidation;
    let safeRequest;
    try {
      decision = resolveRequest(req.body, accounts);
      const expectedOutcome = normalizeExpectedOutcome(req.body?.expectedOutcome);
      if (/^[A-Z]{3}$/.test(decision.intent.currency || '') && expectedOutcome) {
        amountValidation = validateDemoPaymentAmount(
          req.body?.amount,
          decision.intent.currency,
          expectedOutcome
        );
        amount = amountValidation.valid ? amountValidation.amount : null;
      }
      safeRequest = buildSafeRequest(req.body, decision, amount, accounts);
    } catch (error) {
      return next(error);
    }

    try {
      appendRouteEvent(store, 'payments/one-time', safeRequest, decision);
    } catch (error) {
      logger.error('Stage 2 route audit persistence error:', error?.name ?? 'Error');
      return sendProblem(
        res,
        503,
        'AUDIT_PERSISTENCE_FAILED',
        'The route was resolved, but its local audit event could not be saved. No payment was requested.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          audit: { persisted: false },
          retrySafe: true,
        }
      );
    }

    if (!ALLOWED_PAYMENT_TYPES.has(decision.intent.paymentType)) {
      return sendProblem(res, 400, 'INVALID_PAYMENT_TYPE', 'Choose one-time or recurring.');
    }
    if (!safeRequest.transactionMode) {
      return sendProblem(
        res,
        400,
        'INVALID_TRANSACTION_MODE',
        'Choose Sale or Authorize only.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          retrySafe: true,
        }
      );
    }
    if (!safeRequest.expectedOutcome) {
      return sendProblem(
        res,
        400,
        'INVALID_EXPECTED_OUTCOME',
        'Choose Approved, Processor decline, or Gateway rejection.',
        { request: safeRequest, route: toPublicDecision(decision) }
      );
    }
    if (decision.intent.paymentType !== 'one_time') {
      return sendProblem(res, 409, 'ONE_TIME_ONLY', 'This endpoint only executes one-time payments.', {
        request: safeRequest,
        route: toPublicDecision(decision),
      });
    }
    if (!decision.matched) {
      return sendProblem(res, 422, 'NO_ROUTE', decision.reason, {
        request: safeRequest,
        route: toPublicDecision(decision),
      });
    }
    const paymentMethodProblem = getPaymentMethodProblem(
      decision,
      safeRequest.paymentMethod
    );
    if (paymentMethodProblem) {
      return sendProblem(
        res,
        paymentMethodProblem.status,
        paymentMethodProblem.code,
        paymentMethodProblem.message,
        { request: safeRequest, route: toPublicDecision(decision) }
      );
    }
    if (!amount) {
      return sendProblem(
        res,
        400,
        'INVALID_AMOUNT',
        amountValidation?.message || 'Enter a valid amount for the selected currency.',
        { request: safeRequest, route: toPublicDecision(decision) }
      );
    }
    if (
      typeof req.body?.paymentMethodNonce !== 'string' ||
      req.body.paymentMethodNonce.trim() === ''
    ) {
      return sendProblem(
        res,
        400,
        'PAYMENT_METHOD_REQUIRED',
        'Choose and authorize a Sandbox payment method before running the payment.',
        { request: safeRequest, route: toPublicDecision(decision) }
      );
    }

    let nonceDetails;
    try {
      nonceDetails = await gateway().inspectPaymentMethodNonce({
        paymentMethodNonce: req.body.paymentMethodNonce,
      });
    } catch (error) {
      const nonceNotFound = error?.name === 'notFoundError';
      return sendProblem(
        res,
        nonceNotFound ? 400 : 502,
        nonceNotFound
          ? 'PAYMENT_METHOD_INVALID'
          : 'PAYMENT_METHOD_INSPECTION_FAILED',
        nonceNotFound
          ? 'The authorized Sandbox payment method is invalid or expired. Authorize it again before retrying.'
          : 'Braintree could not verify the authorized payment method. No transaction was requested; try again when Sandbox is available.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          retrySafe: true,
        }
      );
    }

    const noncePaymentMethod = paymentMethodFromNonce(nonceDetails);
    if (noncePaymentMethod !== safeRequest.paymentMethod) {
      return sendProblem(
        res,
        422,
        'PAYMENT_METHOD_MISMATCH',
        noncePaymentMethod
          ? 'The authorized payment method does not match the selected method. Authorize the selected method again.'
          : 'Braintree could not prove the authorized payment method type. Authorize the selected method again.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          paymentMethodVerification: {
            passed: false,
            expectedPaymentMethod: safeRequest.paymentMethod,
            actualPaymentMethod: noncePaymentMethod,
          },
          retrySafe: true,
        }
      );
    }

    const nonceThreeDSecureVerification = verifyThreeDSecure({
      source: nonceDetails,
      policy: decision.account.threeDSecurePolicy,
      paymentMethod: safeRequest.paymentMethod,
    });
    if (!nonceThreeDSecureVerification.passed) {
      const missingAuthentication = !nonceThreeDSecureVerification.performed;
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        auditEventId = appendThreeDSecureBlockedEvent(
          store,
          'payments/one-time',
          safeRequest,
          decision,
          nonceThreeDSecureVerification
        ).id;
      } catch (error) {
        logger.error('Stage 6 3D Secure audit persistence error:', error?.name ?? 'Error');
        audit = {
          persisted: false,
          warning: 'The card remained blocked, but its 3D Secure audit event could not be saved.',
        };
      }
      return sendProblem(
        res,
        422,
        missingAuthentication
          ? 'THREE_D_SECURE_REQUIRED'
          : 'THREE_D_SECURE_AUTHENTICATION_FAILED',
        missingAuthentication
          ? 'This route requires 3D Secure. Authenticate the card before retrying; no transaction was requested.'
          : '3D Secure did not produce the liability shift required by this route. Use a successful Sandbox authentication before retrying; no transaction was requested.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          threeDSecureVerification: nonceThreeDSecureVerification,
          auditEventId,
          audit,
          retrySafe: true,
        }
      );
    }

    const orderId = `routing-demo-${normalizeScenarioId(safeRequest.scenarioId, accounts)}-${now()}-${generateId()}`
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 255);
    let result;

    try {
      result = await gateway().createSale({
        merchantAccountId: decision.account.merchantAccountId,
        amount,
        paymentMethodNonce: req.body.paymentMethodNonce,
        orderId,
        submitForSettlement: safeRequest.transactionMode === 'submit_for_settlement',
        // Preserve Braintree's default enforcement for 3DS-enriched nonces on
        // optional routes. Sending false would override an authentication failure.
        ...(nonceThreeDSecureVerification.required
          ? { threeDSecureRequired: true }
          : {}),
      });
    } catch (error) {
      if (isLocallyBlockedGatewayError(error)) {
        return sendProblem(
          res,
          503,
          'CATALOG_UNAVAILABLE',
          'The selected merchant account is no longer active in the current discovery result. No Braintree transaction was requested.',
          {
            request: safeRequest,
            route: toPublicDecision(decision),
            retrySafe: true,
          }
        );
      }

      let auditEventId = null;
      let audit = { persisted: true };
      try {
        const event = store.append({
          type: 'transaction',
          stage: 2,
          endpoint: 'payments/one-time',
          scenarioId: safeRequest.scenarioId,
          intent: toPublicDecision(decision).intent,
          resolvedMerchantAccountId: decision.account.merchantAccountId,
          paymentMethodType: safeRequest.paymentMethod,
          threeDSecurePolicy: nonceThreeDSecureVerification.policy,
          threeDSecureStatus: nonceThreeDSecureVerification.status,
          liabilityShiftPossible:
            nonceThreeDSecureVerification.liabilityShiftPossible,
          liabilityShifted: nonceThreeDSecureVerification.liabilityShifted,
          amount,
          currency: decision.intent.currency,
          transactionMode: safeRequest.transactionMode,
          expectedOutcome: safeRequest.expectedOutcome,
          transactionStatus: null,
          request: safeRequest,
          outcome: 'gateway_error',
          route: toPublicDecision(decision),
          threeDSecureVerification: nonceThreeDSecureVerification,
          error: { name: error?.name ?? 'Error', code: error?.code ?? null },
        });
        auditEventId = event.id;
      } catch (auditError) {
        logger.error('Stage 2 gateway-error audit persistence error:', auditError?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree did not return a usable result and the failed attempt could not be saved locally. Check the Sandbox Control Panel before retrying.',
        };
      }
      return sendProblem(
        res,
        502,
        'BRAINTREE_REQUEST_FAILED',
        'Braintree did not return a usable result. Check the Sandbox Control Panel before retrying.',
        {
          request: safeRequest,
          route: toPublicDecision(decision),
          threeDSecureVerification: nonceThreeDSecureVerification,
          auditEventId,
          audit,
          retrySafe: false,
        }
      );
    }

    const braintreeResult = summarizeGatewayResult(result);
    const verification = verifyMerchantAccount(result, decision.account.merchantAccountId);
    const currencyVerification = verifyTransactionCurrency(
      result,
      decision.intent.currency
    );
    const paymentMethodVerification = verifyTransactionPaymentMethod(
      result,
      safeRequest.paymentMethod
    );
    const threeDSecureVerification = verifyThreeDSecure({
      source: result?.transaction?.threeDSecureInfo,
      policy: decision.account.threeDSecurePolicy,
      paymentMethod: safeRequest.paymentMethod,
    });
    const transactionId = result?.transaction?.id ?? null;
    const transactionStatus = result?.transaction?.status ?? null;
    const actualOutcome = detectGatewayOutcome(result);
    const demoOutcome = {
      expected: safeRequest.expectedOutcome,
      actual: actualOutcome,
      matched: safeRequest.expectedOutcome === actualOutcome,
    };
    const paymentApproved = result?.success === true;
    const routeVerified = result?.transaction
      ? verification.passed && currencyVerification.passed
      : false;
    const paymentMethodVerified = result?.transaction
      ? paymentMethodVerification.passed
      : false;
    const threeDSecureVerified = result?.transaction
      ? threeDSecureVerification.passed
      : false;
    const observationSucceeded =
      demoOutcome.matched &&
      routeVerified &&
      paymentMethodVerified &&
      threeDSecureVerified;
    const controlPanelUrl = buildSandboxTransactionUrl(merchantId, transactionId);
    let auditEventId = null;
    let audit = { persisted: true };

    try {
      const event = store.append({
        type: 'transaction',
        stage: 2,
        endpoint: 'payments/one-time',
        scenarioId: safeRequest.scenarioId,
        intent: toPublicDecision(decision).intent,
        resolvedMerchantAccountId: decision.account.merchantAccountId,
        responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
        verified: routeVerified && paymentMethodVerified && threeDSecureVerified,
        paymentMethodType: safeRequest.paymentMethod,
        responsePaymentInstrumentType: paymentMethodVerification.actualInstrumentType,
        threeDSecurePolicy: threeDSecureVerification.policy,
        threeDSecureStatus: threeDSecureVerification.status,
        liabilityShiftPossible: threeDSecureVerification.liabilityShiftPossible,
        liabilityShifted: threeDSecureVerification.liabilityShifted,
        amount,
        currency: result?.transaction?.currencyIsoCode ?? decision.intent.currency,
        braintreeId: transactionId,
        transactionMode: safeRequest.transactionMode,
        expectedOutcome: safeRequest.expectedOutcome,
        actualOutcome,
        transactionStatus,
        request: safeRequest,
        response: braintreeResult,
        outcome: observationSucceeded
          ? actualOutcome === 'approved'
            ? safeRequest.transactionMode === 'authorize_only'
              ? 'authorized'
              : 'succeeded'
            : `expected_${actualOutcome}`
          : result?.transaction && (
              !routeVerified || !paymentMethodVerified || !threeDSecureVerified
            )
            ? 'failed'
            : `unexpected_${actualOutcome}`,
        route: toPublicDecision(decision),
        verification,
        currencyVerification,
        paymentMethodVerification,
        threeDSecureVerification,
        demoOutcome,
        braintreeResult,
      });
      auditEventId = event.id;
    } catch (error) {
      logger.error('Stage 2 transaction audit persistence error:', error?.name ?? 'Error');
      audit = {
        persisted: false,
        warning:
          'Braintree returned a transaction result, but the local audit event could not be saved. Do not retry a successful payment.',
      };
    }

    const payload = {
      success: observationSucceeded,
      paymentApproved,
      request: safeRequest,
      route: toPublicDecision(decision),
      braintreeResult,
      verification,
      currencyVerification,
      paymentMethodVerification,
      threeDSecureVerification,
      demoOutcome,
      transactionStatus,
      controlPanelUrl,
      auditEventId,
      audit,
      retrySafe: false,
    };
    if (result?.transaction && !routeVerified) {
      return sendProblem(
        res,
        502,
        'ROUTE_VERIFICATION_FAILED',
        'Braintree returned a transaction on a different merchant account or currency. Do not retry; inspect the returned transaction in the Sandbox Control Panel, then start a fresh route preview before any new attempt.',
        payload
      );
    }
    if (result?.transaction && !paymentMethodVerified) {
      return sendProblem(
        res,
        502,
        'PAYMENT_METHOD_VERIFICATION_FAILED',
        'Braintree returned a transaction with a different or unverified payment method. Do not retry; inspect the returned transaction in the Sandbox Control Panel.',
        payload
      );
    }
    if (result?.transaction && !threeDSecureVerified) {
      return sendProblem(
        res,
        502,
        'THREE_D_SECURE_VERIFICATION_FAILED',
        'Braintree returned a transaction without the 3D Secure proof required by this route. Do not retry; inspect the returned transaction in the Sandbox Control Panel.',
        payload
      );
    }
    if (observationSucceeded) {
      return res.status(200).json(payload);
    }

    return res.status(422).json({
      ...payload,
      error: {
        code: 'UNEXPECTED_DEMO_OUTCOME',
        message: paymentApproved
          ? 'Braintree approved the payment when the selected sandbox failure was expected. Do not retry this transaction.'
          : `Braintree returned ${actualOutcome.replaceAll('_', ' ')} instead of the expected ${safeRequest.expectedOutcome.replaceAll('_', ' ')} outcome.`,
      },
    });
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    logger.error('Stage 2 demo API error:', error?.name ?? 'Error');
    return sendProblem(
      res,
      500,
      'DEMO_API_ERROR',
      'The sandbox request could not be completed. Check the server configuration and try again.'
    );
  });

  return router;
}

const router = createDemoApiRouter();
router.createDemoApiRouter = createDemoApiRouter;
router.normalizeAmount = normalizeAmount;
router.normalizeScenarioId = normalizeScenarioId;
router.detectGatewayOutcome = detectGatewayOutcome;

module.exports = router;
