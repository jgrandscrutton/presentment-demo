'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const {
  buildSandboxSubscriptionUrl,
  buildSandboxTransactionUrl,
  summarizeGatewayResult,
  summarizeSubscription,
  summarizeVaultResult,
  verifySubscriptionRoute,
  verifyVaultResult,
} = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const {
  getDemoAmount,
  validateCanonicalAmount,
} = require('../lib/currency');
const eventStore = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const {
  IMPLEMENTED_PAYMENT_METHODS,
  normalizePaymentMethod,
  paymentMethodFromInstrumentType,
  paymentMethodFromNonce,
} = require('../lib/payment-methods');
const { resolveRoute } = require('../lib/routing/resolve-route');
const { verifyThreeDSecure } = require('../lib/three-d-secure');

const RECURRING_MODELS = new Set([
  'merchant_managed',
  'braintree_subscription',
]);
const START_FIELDS = new Set([
  'scenarioId',
  'currency',
  'paymentType',
  'amount',
  'transactionMode',
  'expectedOutcome',
  'recurringModel',
  'planId',
  'paymentMethod',
  'nonce',
]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

class ApiProblem extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function bodyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publicDecision(decision) {
  return {
    matched: decision.matched === true,
    intent: {
      currency: /^[A-Z]{3}$/.test(decision.intent?.currency || '')
        ? decision.intent.currency
        : null,
      paymentType: decision.intent?.paymentType === 'recurring' ||
        decision.intent?.paymentType === 'one_time'
        ? decision.intent.paymentType
        : null,
    },
    account: decision.account || null,
    reason: decision.reason,
    trace: Array.isArray(decision.trace) ? decision.trace : [],
  };
}

function normalizeScenarioId(value) {
  if (typeof value !== 'string') return 'manual';
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(normalized) ? normalized : 'manual';
}

function requireCatalog(service) {
  let state;
  try {
    state = service.getState();
  } catch {
    state = null;
  }
  if (state?.status !== 'ok' || !Array.isArray(state.accounts)) {
    throw new ApiProblem(
      503,
      'CATALOG_UNAVAILABLE',
      state?.error?.message ||
        'Merchant account discovery is unavailable. Refresh the gateway catalog before continuing.',
      { retrySafe: true }
    );
  }

  let accounts;
  try {
    accounts = service.getMerchantAccounts();
  } catch {
    throw new ApiProblem(
      503,
      'CATALOG_UNAVAILABLE',
      'Merchant account discovery is unavailable. Refresh the gateway catalog before continuing.',
      { retrySafe: true }
    );
  }

  return { state, accounts };
}

function requireResolvedRoute(service, intent) {
  const { state, accounts } = requireCatalog(service);
  const decision = resolveRoute(intent, accounts);
  if (!decision.matched) {
    const invalidIntent = !decision.intent.currency || !decision.intent.paymentType;
    throw new ApiProblem(
      invalidIntent ? 400 : 422,
      invalidIntent ? 'INVALID_RECURRING_INTENT' : 'NO_ROUTE',
      decision.reason,
      { route: publicDecision(decision), retrySafe: true }
    );
  }
  return { state, accounts, decision };
}

function normalizeAmount(value, currency) {
  let validation;
  try {
    validation = validateCanonicalAmount(value, currency);
  } catch {
    validation = null;
  }
  if (!validation?.valid) {
    throw new ApiProblem(
      400,
      validation?.code || 'INVALID_AMOUNT',
      validation?.message || 'Enter a valid amount for the selected currency.',
      { retrySafe: true }
    );
  }
  return validation.amount;
}

function requirePaymentMethod(value) {
  if (value === undefined || value === null) return 'card';
  const paymentMethod = normalizePaymentMethod(value);
  if (!paymentMethod || !IMPLEMENTED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new ApiProblem(
      400,
      'INVALID_PAYMENT_METHOD',
      'Choose a supported payment method.',
      { retrySafe: true }
    );
  }
  return paymentMethod;
}

function accountSupportsPaymentMethod(account, paymentMethod) {
  const configured = Array.isArray(account?.paymentMethods)
    ? account.paymentMethods
    : ['card'];
  return configured.includes(paymentMethod);
}

function requireAvailablePaymentMethod(account, paymentMethod) {
  if (accountSupportsPaymentMethod(account, paymentMethod)) return;
  throw new ApiProblem(
    422,
    'PAYMENT_METHOD_UNAVAILABLE',
    `The selected route does not allow ${paymentMethod === 'paypal' ? 'PayPal' : 'card'} payments.`,
    { retrySafe: true }
  );
}

async function inspectNoncePaymentMethod(client, nonce, expectedPaymentMethod) {
  let inspected;
  try {
    inspected = await client.inspectPaymentMethodNonce({
      paymentMethodNonce: nonce,
    });
  } catch {
    throw new ApiProblem(
      502,
      'PAYMENT_METHOD_INSPECTION_FAILED',
      'Braintree could not inspect the one-use payment method. No vault operation was requested.',
      { retrySafe: true }
    );
  }
  const actualPaymentMethod = paymentMethodFromNonce(inspected);
  if (!actualPaymentMethod) {
    throw new ApiProblem(
      422,
      'PAYMENT_METHOD_TYPE_UNVERIFIED',
      'Braintree did not return unambiguous payment-method metadata. No vault operation was requested.',
      { retrySafe: true }
    );
  }
  if (actualPaymentMethod !== expectedPaymentMethod) {
    throw new ApiProblem(
      422,
      'PAYMENT_METHOD_MISMATCH',
      'The tokenized payment method does not match the selected payment method. No vault operation was requested.',
      { retrySafe: true }
    );
  }
  return inspected;
}

function safeStartRequest(body, decision, amount, recurringModel, paymentMethod, plan) {
  return redact({
    scenarioId: normalizeScenarioId(body.scenarioId),
    currency: decision.intent.currency,
    paymentType: decision.intent.paymentType,
    amount,
    paymentMethod,
    transactionMode: 'submit_for_settlement',
    expectedOutcome: 'approved',
    recurringModel,
    ...(plan ? { planId: plan.id } : {}),
  });
}

function sendProblem(res, error) {
  const problem = error instanceof ApiProblem
    ? error
    : new ApiProblem(
        502,
        'BRAINTREE_REQUEST_FAILED',
        'Braintree did not return a usable result. Check the Sandbox Control Panel before retrying.',
        { retrySafe: false }
      );
  return res.status(problem.status).json(redact({
    success: false,
    error: { code: problem.code, message: problem.message },
    ...problem.details,
  }));
}

function safeResultMessage(result, fallback) {
  return summarizeGatewayResult(result).message || fallback;
}

function transactionRouteVerification(result, account, paymentMethod = 'card') {
  const transaction = result?.transaction;
  const expectedMerchantAccountId = account?.merchantAccountId ?? null;
  const expectedCurrency = account?.currency ?? null;
  const actualMerchantAccountId = transaction?.merchantAccountId ?? null;
  const actualCurrency = transaction?.currencyIsoCode ?? null;
  const actualPaymentMethod = paymentMethodFromInstrumentType(
    transaction?.paymentInstrumentType
  );
  const instrumentMatched = actualPaymentMethod === paymentMethod;
  const passed = Boolean(
    transaction &&
    actualMerchantAccountId === expectedMerchantAccountId &&
    actualCurrency === expectedCurrency &&
    instrumentMatched
  );
  return {
    passed,
    expectedMerchantAccountId,
    actualMerchantAccountId,
    expectedCurrency,
    actualCurrency,
    expectedPaymentMethod: paymentMethod,
    actualPaymentMethod,
    instrumentMatched,
    explanation: passed
      ? 'Braintree returned the payment method, merchant account, and currency selected by the server.'
      : 'The payment method, merchant account, or currency returned by Braintree did not match the selected route.',
  };
}

function combinedVerification(vaultVerification, routeVerification, subject) {
  const passed = vaultVerification?.passed === true && routeVerification?.passed === true;
  return {
    passed,
    vaultVerified: vaultVerification?.passed === true,
    routeVerified: routeVerification?.passed === true,
    expectedMerchantAccountId: routeVerification?.expectedMerchantAccountId ??
      vaultVerification?.expectedMerchantAccountId ?? null,
    actualMerchantAccountId: routeVerification?.actualMerchantAccountId ??
      vaultVerification?.actualMerchantAccountId ?? null,
    expectedCurrency: routeVerification?.expectedCurrency ??
      vaultVerification?.expectedCurrency ?? null,
    actualCurrency: routeVerification?.actualCurrency ??
      vaultVerification?.actualCurrency ?? null,
    expectedPaymentMethod: routeVerification?.expectedPaymentMethod ??
      vaultVerification?.paymentMethod ?? null,
    actualPaymentMethod: routeVerification?.actualPaymentMethod ?? null,
    actualPaymentMethods: routeVerification?.actualPaymentMethods ?? null,
    instrumentEvidenceAvailable:
      routeVerification?.instrumentEvidenceAvailable ?? null,
    instrumentMatched: routeVerification?.instrumentMatched ??
      vaultVerification?.methodMatched ?? false,
    explanation: passed
      ? `The vaulted payment method and ${subject} match the server-owned route.`
      : `The vaulted payment method or ${subject} did not match the server-owned route.`,
  };
}

function vaultSetupThreeDSecureVerification(verification) {
  return Object.freeze({
    ...verification,
    evidenceScope: 'vault_setup',
    transactionAuthenticated: false,
    explanation: `${verification.explanation} This evidence applies only to the vault setup and is not proof that a later subscription transaction was authenticated.`,
  });
}

function unauthenticatedTransactionThreeDSecureVerification({
  policy,
  paymentMethod,
  evidenceScope,
  explanation,
}) {
  const verification = verifyThreeDSecure({
    source: null,
    policy,
    paymentMethod,
  });
  return Object.freeze({
    ...verification,
    evidenceScope,
    transactionAuthenticated: false,
    explanation: paymentMethod === 'card' ? explanation : verification.explanation,
  });
}

function subscriptionTransactionThreeDSecureVerification(options) {
  return unauthenticatedTransactionThreeDSecureVerification({
    ...options,
    evidenceScope: 'subscription_transaction',
    explanation:
      'The subscription was created from a vaulted token, so no transaction-level 3D Secure evidence is claimed.',
  });
}

function vaultedOneTimeThreeDSecureVerification(options) {
  return unauthenticatedTransactionThreeDSecureVerification({
    ...options,
    evidenceScope: 'vaulted_one_time_transaction',
    explanation:
      'This vaulted one-time transaction has no fresh 3D Secure authentication evidence.',
  });
}

function recurringThreeDSecureEvidence(root, account, paymentMethod) {
  const policy = root.threeDSecurePolicy || account.threeDSecurePolicy;
  const topLevelSource = {
    status: root.threeDSecureStatus ?? null,
    liabilityShiftPossible: root.liabilityShiftPossible ?? null,
    liabilityShifted: root.liabilityShifted ?? null,
  };

  if (root.recurringModel === 'braintree_subscription') {
    const threeDSecureVerification =
      subscriptionTransactionThreeDSecureVerification({ policy, paymentMethod });
    const vaultVerification = verifyThreeDSecure({
      source: root.vaultThreeDSecureVerification ?? null,
      policy,
      paymentMethod,
    });
    return {
      threeDSecureVerification,
      vaultThreeDSecureVerification:
        vaultSetupThreeDSecureVerification(vaultVerification),
    };
  }

  const setupSource = root.threeDSecureVerification || topLevelSource;
  const threeDSecureVerification = vaultSetupThreeDSecureVerification(
    verifyThreeDSecure({ source: setupSource, policy, paymentMethod })
  );
  const vaultVerification = verifyThreeDSecure({
    source: root.vaultThreeDSecureVerification || setupSource,
    policy,
    paymentMethod,
  });
  return {
    threeDSecureVerification,
    vaultThreeDSecureVerification:
      vaultSetupThreeDSecureVerification(vaultVerification),
  };
}

function subscriptionVerification(result, account, planId, paymentMethod = 'card') {
  const routeVerification = verifySubscriptionRoute(result, account);
  const subscription = result?.subscription || result;
  const actualPlanId = typeof subscription?.planId === 'string'
    ? subscription.planId
    : null;
  const planMatched = actualPlanId === planId;
  const transactions = Array.isArray(subscription?.transactions)
    ? subscription.transactions
    : [];
  const returnedMethods = transactions.map((transaction) =>
    paymentMethodFromInstrumentType(transaction?.paymentInstrumentType)
  );
  const instrumentMatched = transactions.length === 0 ||
    returnedMethods.every((method) => method === paymentMethod);
  return {
    ...routeVerification,
    passed: routeVerification.passed && planMatched && instrumentMatched,
    planMatched,
    expectedPaymentMethod: paymentMethod,
    actualPaymentMethods: returnedMethods,
    instrumentEvidenceAvailable: transactions.length > 0,
    instrumentMatched,
    expectedPlanId: planId,
    actualPlanId,
    explanation: routeVerification.passed && planMatched && instrumentMatched
      ? routeVerification.explanation
      : 'The subscription payment method, merchant account, currency evidence, or plan did not match the selected route.',
  };
}

function makeCustomerId(now, generateId) {
  const random = String(generateId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const timestamp = Number(now()).toString(36).replace(/[^A-Za-z0-9]/g, '');
  return `demo-${timestamp}-${random || crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    .slice(0, 36);
}

function makeOrderId(prefix, scenarioId, now, generateId) {
  return `${prefix}-${normalizeScenarioId(scenarioId)}-${now()}-${generateId()}`
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 255);
}

function extractPaymentMethodToken(vaultResult) {
  const customer = vaultResult?.customer;
  const candidates = [
    vaultResult?.paymentMethod,
    vaultResult?.creditCard,
    vaultResult?.paypalAccount,
    ...(Array.isArray(customer?.creditCards) ? customer.creditCards : []),
    ...(Array.isArray(customer?.paypalAccounts) ? customer.paypalAccounts : []),
    ...(Array.isArray(customer?.paymentMethods) ? customer.paymentMethods : []),
  ].filter((candidate) => candidate && typeof candidate === 'object');
  const selected = candidates.find(
    (candidate) => candidate.default === true &&
      typeof candidate.token === 'string' && candidate.token.trim() !== ''
  ) || candidates.find(
    (candidate) => typeof candidate.token === 'string' && candidate.token.trim() !== ''
  );
  return selected?.token?.trim() || null;
}

function appendRouteEvent(store, safeRequest, decision) {
  return store.append({
    type: 'route_resolution',
    stage: 3,
    endpoint: 'recurring/start',
    scenarioId: safeRequest.scenarioId,
    intent: publicDecision(decision).intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    threeDSecurePolicy: decision.account.threeDSecurePolicy,
    paymentMethod: safeRequest.paymentMethod,
    paymentMethodType: safeRequest.paymentMethod,
    amount: safeRequest.amount,
    currency: decision.intent.currency,
    transactionMode: 'submit_for_settlement',
    expectedOutcome: 'approved',
    recurringModel: safeRequest.recurringModel,
    planId: safeRequest.planId ?? null,
    request: safeRequest,
    outcome: 'matched',
    route: publicDecision(decision),
  });
}

function appendThreeDSecureBlockedEvent(store, context, verification) {
  return store.append({
    type: 'three_d_secure',
    stage: 6,
    endpoint: 'recurring/start',
    scenarioId: context.scenarioId,
    intent: publicDecision(context.decision).intent,
    resolvedMerchantAccountId: context.decision.account.merchantAccountId,
    verified: false,
    paymentMethodType: context.paymentMethod,
    threeDSecurePolicy: verification.policy,
    threeDSecureStatus: verification.status,
    liabilityShiftPossible: verification.liabilityShiftPossible,
    liabilityShifted: verification.liabilityShifted,
    threeDSecureEvidenceScope: verification.evidenceScope ?? null,
    transactionThreeDSecureAuthenticated:
      verification.transactionAuthenticated ?? null,
    amount: context.amount,
    currency: context.decision.intent.currency,
    outcome: 'blocked',
    recurringModel: context.recurringModel,
    planId: context.plan?.id ?? null,
    request: context.safeRequest,
    route: publicDecision(context.decision),
    threeDSecureVerification: verification,
  });
}

function appendVaultEvent(store, context, result, verification, customerId) {
  const threeDSecure = context.vaultThreeDSecureVerification ||
    context.threeDSecureVerification;
  return store.append({
    type: 'vault',
    stage: 3,
    endpoint: 'recurring/start',
    scenarioId: context.safeRequest.scenarioId,
    intent: publicDecision(context.decision).intent,
    resolvedMerchantAccountId: context.decision.account.merchantAccountId,
    responseMerchantAccountId: verification.actualMerchantAccountId,
    verified: verification.routeVerified === false ? false : verification.passed,
    paymentMethodVerified: verification.passed,
    paymentMethod: context.paymentMethod,
    paymentMethodType: context.paymentMethod === 'paypal'
      ? 'paypal_account'
      : 'credit_card',
    threeDSecurePolicy: threeDSecure?.policy ?? null,
    threeDSecureStatus: threeDSecure?.status ?? null,
    liabilityShiftPossible: threeDSecure?.liabilityShiftPossible ?? null,
    liabilityShifted: threeDSecure?.liabilityShifted ?? null,
    threeDSecureEvidenceScope: threeDSecure?.evidenceScope ?? null,
    transactionThreeDSecureAuthenticated:
      threeDSecure?.transactionAuthenticated ?? null,
    currency: verification.actualCurrency || context.decision.intent.currency,
    customerId,
    recurringModel: context.recurringModel,
    planId: context.plan?.id ?? null,
    request: context.safeRequest,
    response: summarizeVaultResult(result),
    verification,
    threeDSecureVerification: threeDSecure ?? null,
    outcome: verification.passed && result?.success === true ? 'succeeded' : 'failed',
  });
}

function appendTransactionEvent({
  store,
  context,
  result,
  verification,
  transactionSource,
  billingCycle,
  endpoint,
  relatedEventId = null,
}) {
  const transaction = result?.transaction;
  const threeDSecure = context.threeDSecureVerification;
  const vaultThreeDSecure = context.vaultThreeDSecureVerification;
  return store.append({
    type: 'transaction',
    stage: 3,
    action: billingCycle,
    endpoint,
    scenarioId: context.scenarioId,
    intent: publicDecision(context.decision).intent,
    resolvedMerchantAccountId: context.decision.account.merchantAccountId,
    responseMerchantAccountId: transaction?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethod: context.paymentMethod,
    paymentMethodType: transaction?.paymentInstrumentType ||
      (context.paymentMethod === 'paypal' ? 'paypal_account' : 'credit_card'),
    threeDSecurePolicy: threeDSecure?.policy ?? null,
    threeDSecureStatus: threeDSecure?.status ?? null,
    liabilityShiftPossible: threeDSecure?.liabilityShiftPossible ?? null,
    liabilityShifted: threeDSecure?.liabilityShifted ?? null,
    threeDSecureEvidenceScope: threeDSecure?.evidenceScope ?? null,
    transactionThreeDSecureAuthenticated:
      threeDSecure?.transactionAuthenticated ?? null,
    amount: context.amount,
    currency: transaction?.currencyIsoCode || context.decision.intent.currency,
    outcome: result?.success === true && verification.passed ? 'succeeded' : 'failed',
    transactionStatus: transaction?.status ?? null,
    transactionSource: transactionSource || null,
    recurringModel: context.recurringModel,
    billingCycle,
    customerId: context.customerId,
    vaultEventId: context.vaultEventId,
    braintreeId: transaction?.id ?? null,
    relatedEventId,
    request: {
      scenarioId: context.scenarioId,
      currency: context.decision.intent.currency,
      paymentType: context.decision.intent.paymentType,
      paymentMethod: context.paymentMethod,
      amount: context.amount,
      recurringModel: context.recurringModel,
      ...(transactionSource ? { transactionSource } : {}),
    },
    response: summarizeGatewayResult(result),
    verification,
    threeDSecureVerification: threeDSecure ?? null,
    vaultThreeDSecureVerification: vaultThreeDSecure ?? null,
    route: publicDecision(context.decision),
  });
}

function appendSubscriptionEvent({
  store,
  context,
  result,
  verification,
  action = null,
  relatedEventId = null,
  endpoint,
}) {
  const summary = summarizeSubscription(result);
  const threeDSecure = context.threeDSecureVerification;
  const vaultThreeDSecure = context.vaultThreeDSecureVerification;
  const normalizedStatus = String(summary?.status || '').trim().toLowerCase();
  const actionConfirmed = action !== 'cancel' ||
    ['canceled', 'cancelled'].includes(normalizedStatus);
  return store.append({
    type: action ? 'subscription_action' : 'subscription',
    stage: 3,
    action,
    endpoint,
    scenarioId: context.scenarioId,
    intent: { currency: context.currency, paymentType: 'recurring' },
    resolvedMerchantAccountId: context.merchantAccountId,
    responseMerchantAccountId: summary?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethod: context.paymentMethod,
    paymentMethodType: context.paymentMethod === 'paypal'
      ? 'paypal_account'
      : 'credit_card',
    threeDSecurePolicy: threeDSecure?.policy ?? null,
    threeDSecureStatus: threeDSecure?.status ?? null,
    liabilityShiftPossible: threeDSecure?.liabilityShiftPossible ?? null,
    liabilityShifted: threeDSecure?.liabilityShifted ?? null,
    threeDSecureEvidenceScope: threeDSecure?.evidenceScope ?? null,
    transactionThreeDSecureAuthenticated:
      threeDSecure?.transactionAuthenticated ?? null,
    amount: summary?.price ?? context.amount ?? null,
    currency: context.currency,
    outcome:
      result?.success === false || !verification.passed || !actionConfirmed
        ? 'failed'
        : 'succeeded',
    recurringModel: 'braintree_subscription',
    customerId: context.customerId,
    vaultEventId: context.vaultEventId,
    planId: context.planId,
    subscriptionId: summary?.id ?? context.subscriptionId ?? null,
    subscriptionStatus: summary?.status ?? null,
    nextBillingDate: summary?.nextBillingDate ?? null,
    relatedEventId,
    request: {
      scenarioId: context.scenarioId,
      currency: context.currency,
      paymentType: 'recurring',
      paymentMethod: context.paymentMethod,
      recurringModel: 'braintree_subscription',
      planId: context.planId,
      ...(action ? { action } : {}),
    },
    response: summary,
    verification,
    threeDSecureVerification: threeDSecure ?? null,
    vaultThreeDSecureVerification: vaultThreeDSecure ?? null,
  });
}

function requireEmptyActionBody(req) {
  const body = bodyObject(req.body);
  if (Object.keys(body).length > 0) {
    throw new ApiProblem(
      400,
      'UNEXPECTED_RECURRING_ACTION_INPUT',
      'Customer, subscription, transaction, amount, and merchant-account authority comes from the trusted audit event.',
      { retrySafe: true }
    );
  }
}

function activeAccount(service, merchantAccountId) {
  try {
    const account = typeof service.getMerchantAccountById === 'function'
      ? service.getMerchantAccountById(merchantAccountId)
      : service.getMerchantAccounts().find(
          (candidate) => candidate.merchantAccountId === merchantAccountId
        );
    return account?.status === 'active' ? account : null;
  } catch {
    return null;
  }
}

function requireRecurringRoot(
  eventId,
  service,
  store,
  {
    model,
    allowSubscription = false,
    requireAmount = true,
    requireSetupEvidence = true,
  } = {}
) {
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
    throw new ApiProblem(
      400,
      'INVALID_EVENT_ID',
      'Choose a valid recurring audit event.',
      { retrySafe: true }
    );
  }
  const root = store.get(eventId);
  if (!root) {
    throw new ApiProblem(
      404,
      'EVENT_NOT_FOUND',
      'That recurring audit event was not found.',
      { retrySafe: true }
    );
  }
  const validType = root.type === 'transaction' || (allowSubscription && root.type === 'subscription');
  if (
    !validType ||
    root.stage !== 3 ||
    root.relatedEventId ||
    !RECURRING_MODELS.has(root.recurringModel) ||
    (model && root.recurringModel !== model)
  ) {
    throw new ApiProblem(
      409,
      'ROOT_RECURRING_EVENT_REQUIRED',
      'This action requires an original verified Stage 3 recurring event.',
      { retrySafe: true }
    );
  }
  if (root.outcome !== 'succeeded') {
    throw new ApiProblem(
      409,
      'RECURRING_START_NOT_SUCCESSFUL',
      'Follow-up actions require a successfully completed recurring start.',
      { retrySafe: true }
    );
  }
  if (
    root.type === 'transaction' &&
    (root.billingCycle !== 'first' || root.transactionSource !== 'recurring_first')
  ) {
    throw new ApiProblem(
      409,
      'ROOT_RECURRING_EVENT_REQUIRED',
      'Follow-up actions require the original successful first-cycle event.',
      { retrySafe: true }
    );
  }

  const { state, accounts } = requireCatalog(service);
  if (!root.gatewayMerchantId) {
    throw new ApiProblem(
      409,
      'LEGACY_EVENT_READ_ONLY',
      'This legacy event is read-only.',
      { retrySafe: true }
    );
  }
  if (root.gatewayMerchantId !== state.gatewayMerchantId) {
    throw new ApiProblem(
      409,
      'HISTORICAL_GATEWAY_READ_ONLY',
      'This recurring event belongs to a different gateway configuration and is read-only.',
      { retrySafe: true }
    );
  }
  if (
    root.verified !== true ||
    typeof root.resolvedMerchantAccountId !== 'string' ||
    (root.responseMerchantAccountId &&
      root.responseMerchantAccountId !== root.resolvedMerchantAccountId)
  ) {
    throw new ApiProblem(
      409,
      'UNVERIFIED_ROUTE_READ_ONLY',
      'The original recurring route was not verified, so this event is read-only.',
      { retrySafe: true }
    );
  }
  if (typeof root.customerId !== 'string' || !/^demo-[A-Za-z0-9_-]{1,31}$/.test(root.customerId)) {
    throw new ApiProblem(
      409,
      'PERSISTED_RECURRING_CONTEXT_INVALID',
      'The recurring event does not contain a valid demo customer reference.',
      { retrySafe: true }
    );
  }
  const currency = typeof root.currency === 'string'
    ? root.currency.trim().toUpperCase()
    : String(root.intent?.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiProblem(
      409,
      'PERSISTED_RECURRING_CONTEXT_INVALID',
      'The recurring event does not contain a valid currency.',
      { retrySafe: true }
    );
  }
  const originalAccount = activeAccount(service, root.resolvedMerchantAccountId);
  if (!originalAccount || originalAccount.currency !== currency) {
    throw new ApiProblem(
      409,
      'MERCHANT_ACCOUNT_INACTIVE',
      'The original merchant account is no longer an active account for this currency.',
      { retrySafe: true }
    );
  }
  const paymentMethod = normalizePaymentMethod(root.paymentMethod) ||
    normalizePaymentMethod(root.paymentMethodType) ||
    paymentMethodFromInstrumentType(root.paymentMethodType);
  if (!paymentMethod || !IMPLEMENTED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new ApiProblem(
      409,
      'PERSISTED_RECURRING_CONTEXT_INVALID',
      'The recurring event does not contain a supported payment-method reference.',
      { retrySafe: true }
    );
  }
  if (!accountSupportsPaymentMethod(originalAccount, paymentMethod)) {
    throw new ApiProblem(
      409,
      'PAYMENT_METHOD_UNAVAILABLE',
      'The original merchant account no longer allows this payment method.',
      { retrySafe: true }
    );
  }
  const amount = requireAmount
    ? root.type === 'subscription'
      ? getDemoAmount(currency)
      : normalizeAmount(root.amount, currency)
    : root.amount ?? null;
  const {
    threeDSecureVerification,
    vaultThreeDSecureVerification,
  } = recurringThreeDSecureEvidence(root, originalAccount, paymentMethod);
  if (requireSetupEvidence && !threeDSecureVerification.passed) {
    throw new ApiProblem(
      409,
      'THREE_D_SECURE_EVIDENCE_REQUIRED',
      'The original recurring setup does not contain the 3D Secure proof now required by this route, so this event is read-only.',
      { retrySafe: true }
    );
  }

  return {
    root,
    state,
    accounts,
    originalAccount,
    currency,
    amount,
    customerId: root.customerId,
    vaultEventId: root.vaultEventId,
    scenarioId: root.scenarioId || 'manual',
    recurringModel: root.recurringModel,
    paymentMethod,
    threeDSecureVerification,
    vaultThreeDSecureVerification,
  };
}

function requireSubscriptionRoot(eventId, service, store) {
  const context = requireRecurringRoot(eventId, service, store, {
    model: 'braintree_subscription',
    allowSubscription: true,
    requireAmount: false,
    requireSetupEvidence: false,
  });
  if (
    context.root.type !== 'subscription' ||
    typeof context.root.subscriptionId !== 'string' ||
    context.root.subscriptionId.trim() === '' ||
    typeof context.root.planId !== 'string' ||
    context.root.planId.trim() === ''
  ) {
    throw new ApiProblem(
      409,
      'ROOT_SUBSCRIPTION_EVENT_REQUIRED',
      'This action requires an original verified subscription event.',
      { retrySafe: true }
    );
  }
  return {
    ...context,
    merchantAccountId: context.originalAccount.merchantAccountId,
    subscriptionId: context.root.subscriptionId.trim(),
    planId: context.root.planId.trim(),
  };
}

function createDemoRecurringApiRouter({
  gatewayClient,
  getClient = getGatewayClient,
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
  merchantId = process.env.BRAINTREE_MERCHANT_ID || process.env.MERCHANT_ID,
  now = () => Date.now(),
  generateId = () => crypto.randomUUID(),
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

  router.post('/start', async (req, res) => {
    let routeContext;
    let vaultRequested = false;
    let billingRequested = false;
    let vaultEvent = null;
    let customerId = null;
    try {
      const body = bodyObject(req.body);
      const unexpected = Object.keys(body).filter((field) => !START_FIELDS.has(field));
      if (unexpected.length > 0) {
        throw new ApiProblem(
          400,
          'INVALID_RECURRING_INPUT',
          'Only recurring intent, model, plan, amount, and a one-use payment nonce are accepted.',
          { retrySafe: true }
        );
      }
      if (String(body.paymentType || '').trim().toLowerCase().replace(/[-\s]+/g, '_') !== 'recurring') {
        throw new ApiProblem(400, 'RECURRING_ONLY', 'This endpoint only starts recurring payments.', {
          retrySafe: true,
        });
      }
      if (
        body.transactionMode !== undefined &&
        body.transactionMode !== 'submit_for_settlement'
      ) {
        throw new ApiProblem(
          400,
          'INVALID_TRANSACTION_MODE',
          'Recurring starts must submit for settlement.',
          { retrySafe: true }
        );
      }
      if (body.expectedOutcome !== undefined && body.expectedOutcome !== 'approved') {
        throw new ApiProblem(
          400,
          'INVALID_EXPECTED_OUTCOME',
          'Recurring starts use the approved Sandbox path.',
          { retrySafe: true }
        );
      }
      const recurringModel = typeof body.recurringModel === 'string'
        ? body.recurringModel.trim()
        : '';
      if (!RECURRING_MODELS.has(recurringModel)) {
        throw new ApiProblem(
          400,
          'INVALID_RECURRING_MODEL',
          'Choose merchant-managed recurring or Braintree Subscriptions.',
          { retrySafe: true }
        );
      }
      const paymentMethod = requirePaymentMethod(body.paymentMethod);
      if (typeof body.nonce !== 'string' || body.nonce.trim() === '') {
        throw new ApiProblem(
          400,
          'PAYMENT_METHOD_REQUIRED',
          'Approve or tokenize the selected Sandbox payment method before starting recurring billing.',
          { retrySafe: true }
        );
      }

      const service = catalog();
      const resolved = requireResolvedRoute(service, {
        currency: body.currency,
        paymentType: body.paymentType,
      });
      requireAvailablePaymentMethod(resolved.decision.account, paymentMethod);
      let plan = null;
      if (recurringModel === 'braintree_subscription') {
        try {
          plan = service.assertPlanForRoute(body.planId, resolved.decision.intent.currency);
        } catch (error) {
          if (error?.code === 'PLAN_CATALOG_UNAVAILABLE') {
            throw new ApiProblem(503, error.code, error.message, { retrySafe: true });
          }
          if (error?.code === 'PLAN_NOT_FOUND' || error?.code === 'PLAN_ROUTE_MISMATCH') {
            throw new ApiProblem(422, error.code, error.message, { retrySafe: true });
          }
          throw new ApiProblem(
            400,
            'INVALID_PLAN',
            'Choose a discovered plan for the routed currency.',
            { retrySafe: true }
          );
        }
      }
      const amount = recurringModel === 'braintree_subscription'
        ? String(plan.price)
        : normalizeAmount(body.amount, resolved.decision.intent.currency);
      const safeRequest = safeStartRequest(
        body,
        resolved.decision,
        amount,
        recurringModel,
        paymentMethod,
        plan
      );
      routeContext = {
        ...resolved,
        recurringModel,
        plan,
        amount,
        paymentMethod,
        safeRequest,
        scenarioId: safeRequest.scenarioId,
      };

      try {
        appendRouteEvent(store, safeRequest, resolved.decision);
      } catch (error) {
        logger.error('Stage 3 route audit persistence error:', error?.name ?? 'Error');
        throw new ApiProblem(
          503,
          'AUDIT_PERSISTENCE_FAILED',
          'The route was resolved, but its audit event could not be saved. No Braintree operation was requested.',
          { request: safeRequest, route: publicDecision(resolved.decision), retrySafe: true }
        );
      }

      const inspectedNonce = await inspectNoncePaymentMethod(
        gateway(),
        body.nonce.trim(),
        paymentMethod
      );
      let threeDSecureVerification = verifyThreeDSecure({
        source: inspectedNonce,
        policy: resolved.decision.account.threeDSecurePolicy,
        paymentMethod,
      });
      if (paymentMethod === 'card') {
        threeDSecureVerification =
          vaultSetupThreeDSecureVerification(threeDSecureVerification);
        routeContext.vaultThreeDSecureVerification = threeDSecureVerification;
      }
      routeContext.threeDSecureVerification = threeDSecureVerification;
      if (!threeDSecureVerification.passed) {
        const missingAuthentication = !threeDSecureVerification.performed;
        let auditEventId = null;
        let audit = { persisted: true };
        try {
          auditEventId = appendThreeDSecureBlockedEvent(
            store,
            routeContext,
            threeDSecureVerification
          ).id;
        } catch (error) {
          logger.error('Stage 6 3D Secure audit persistence error:', error?.name ?? 'Error');
          audit = {
            persisted: false,
            warning: 'The vault remained blocked, but its 3D Secure audit event could not be saved.',
          };
        }
        throw new ApiProblem(
          422,
          missingAuthentication
            ? 'THREE_D_SECURE_REQUIRED'
            : 'THREE_D_SECURE_AUTHENTICATION_FAILED',
          missingAuthentication
            ? 'This recurring route requires 3D Secure. Authenticate the card before retrying; no vault operation was requested.'
            : '3D Secure did not produce the liability shift required by this recurring route. No vault operation was requested.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            threeDSecureVerification,
            auditEventId,
            audit,
            retrySafe: true,
          }
        );
      }
      if (
        recurringModel === 'braintree_subscription' &&
        paymentMethod === 'card' &&
        threeDSecureVerification.required
      ) {
        const vaultThreeDSecureVerification =
          routeContext.vaultThreeDSecureVerification;
        throw new ApiProblem(
          422,
          'THREE_D_SECURE_SUBSCRIPTION_REAUTH_REQUIRED',
          'This required-3D-Secure route cannot safely carry a one-use authentication through vaulting into Braintree Subscription.create. Choose merchant-managed recurring or a route where 3D Secure is optional; no customer or subscription was requested.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            threeDSecureVerification: vaultThreeDSecureVerification,
            retrySafe: true,
          }
        );
      }
      customerId = makeCustomerId(now, generateId);
      vaultRequested = true;
      const rawVaultResult = await gateway().createVaultedCustomer({
        customerId,
        paymentMethodNonce: body.nonce.trim(),
        merchantAccountId: resolved.decision.account.merchantAccountId,
        paymentMethod,
      });
      const vaultSummary = summarizeVaultResult(rawVaultResult);
      const vaultVerification = verifyVaultResult(
        rawVaultResult,
        resolved.decision.account,
        paymentMethod
      );

      try {
        vaultEvent = appendVaultEvent(
          store,
          routeContext,
          rawVaultResult,
          vaultVerification,
          customerId
        );
      } catch (error) {
        logger.error('Stage 3 vault audit persistence error:', error?.name ?? 'Error');
        throw new ApiProblem(
          503,
          'AUDIT_PERSISTENCE_FAILED',
          'Braintree returned a vault result, but its audit event could not be saved. No billing operation was requested; do not retry the vault blindly.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            vaultResult: vaultSummary,
            verification: vaultVerification,
            threeDSecureVerification,
            retrySafe: false,
          }
        );
      }
      if (rawVaultResult?.success !== true) {
        throw new ApiProblem(
          422,
          'VAULT_CREATION_FAILED',
          vaultSummary.message || 'Braintree did not vault the payment method.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            vaultResult: vaultSummary,
            verification: vaultVerification,
            threeDSecureVerification,
            auditEventId: vaultEvent.id,
            retrySafe: false,
          }
        );
      }
      if (!vaultVerification.passed) {
        throw new ApiProblem(
          502,
          paymentMethod === 'card'
            ? 'ROUTE_VERIFICATION_FAILED'
            : 'VAULT_VERIFICATION_FAILED',
          paymentMethod === 'card'
            ? 'The vault verification did not match the resolved merchant account and currency. No billing operation was requested.'
            : 'Braintree did not return proof of the selected vaulted payment method. No billing operation was requested.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            vaultResult: vaultSummary,
            verification: vaultVerification,
            threeDSecureVerification,
            auditEventId: vaultEvent.id,
            retrySafe: false,
          }
        );
      }

      if (recurringModel === 'merchant_managed') {
        const operationContext = {
          ...routeContext,
          customerId,
          vaultEventId: vaultEvent.id,
        };
        billingRequested = true;
        const result = await gateway().createSale({
          merchantAccountId: resolved.decision.account.merchantAccountId,
          amount,
          customerId,
          orderId: makeOrderId('demo-recurring-first', safeRequest.scenarioId, now, generateId),
          submitForSettlement: true,
          transactionSource: 'recurring_first',
        });
        const routeVerification = transactionRouteVerification(
          result,
          resolved.decision.account,
          paymentMethod
        );
        const verification = combinedVerification(
          vaultVerification,
          routeVerification,
          'first recurring transaction'
        );
        let auditEventId = null;
        let audit = { persisted: true };
        try {
          auditEventId = appendTransactionEvent({
            store,
            context: operationContext,
            result,
            verification,
            transactionSource: 'recurring_first',
            billingCycle: 'first',
            endpoint: 'recurring/start',
          }).id;
        } catch (error) {
          logger.error('Stage 3 transaction audit persistence error:', error?.name ?? 'Error');
          audit = {
            persisted: false,
            warning:
              'Braintree returned the first recurring result, but the local audit event could not be saved. Do not retry or run a follow-up action.',
          };
        }
        const payload = {
          success: result?.success === true && verification.passed,
          request: safeRequest,
          route: publicDecision(resolved.decision),
          recurringModel,
          transactionSource: 'recurring_first',
          vaultResult: vaultSummary,
          vaultVerification,
          threeDSecureVerification,
          vaultThreeDSecureVerification:
            routeContext.vaultThreeDSecureVerification ?? null,
          braintreeResult: summarizeGatewayResult(result),
          verification,
          transactionStatus: result?.transaction?.status ?? null,
          controlPanelUrl: buildSandboxTransactionUrl(merchantId, result?.transaction?.id),
          auditEventId,
          audit,
          retrySafe: false,
        };
        if (result?.success !== true && !result?.transaction) {
          throw new ApiProblem(
            422,
            'BRAINTREE_RECURRING_FAILED',
            summarizeGatewayResult(result).message ||
              'Braintree did not complete the first recurring transaction.',
            payload
          );
        }
        if (!verification.passed) {
          throw new ApiProblem(
            502,
            'ROUTE_VERIFICATION_FAILED',
            'Braintree returned the first recurring transaction on a different merchant account or currency. Do not retry.',
            payload
          );
        }
        if (result?.success !== true) {
          throw new ApiProblem(
            422,
            'BRAINTREE_RECURRING_FAILED',
            summarizeGatewayResult(result).message ||
              'Braintree did not complete the first recurring transaction.',
            payload
          );
        }
        return res.json(payload);
      }

      const paymentMethodToken = extractPaymentMethodToken(rawVaultResult);
      if (!paymentMethodToken) {
        throw new ApiProblem(
          502,
          'VAULT_TOKEN_UNAVAILABLE',
          'Braintree vaulted the payment method but did not return a usable server-side reference. No subscription was requested.',
          {
            request: safeRequest,
            route: publicDecision(resolved.decision),
            vaultResult: vaultSummary,
            verification: vaultVerification,
            threeDSecureVerification,
            auditEventId: vaultEvent.id,
            retrySafe: false,
          }
        );
      }
      const vaultThreeDSecureVerification =
        routeContext.vaultThreeDSecureVerification ||
        vaultSetupThreeDSecureVerification(threeDSecureVerification);
      const subscriptionThreeDSecureVerification =
        subscriptionTransactionThreeDSecureVerification({
          policy: resolved.decision.account.threeDSecurePolicy,
          paymentMethod,
        });
      routeContext.vaultThreeDSecureVerification = vaultThreeDSecureVerification;
      routeContext.threeDSecureVerification = subscriptionThreeDSecureVerification;
      billingRequested = true;
      const result = await gateway().createSubscription({
        merchantAccountId: resolved.decision.account.merchantAccountId,
        paymentMethodToken,
        planId: plan.id,
      });
      const routeVerification = subscriptionVerification(
        result,
        resolved.decision.account,
        plan.id,
        paymentMethod
      );
      const verification = combinedVerification(
        vaultVerification,
        routeVerification,
        'subscription'
      );
      const subscription = summarizeSubscription(result);
      const subscriptionContext = {
        scenarioId: safeRequest.scenarioId,
        currency: resolved.decision.intent.currency,
        merchantAccountId: resolved.decision.account.merchantAccountId,
        amount: plan.price,
        customerId,
        vaultEventId: vaultEvent.id,
        planId: plan.id,
        paymentMethod,
        threeDSecureVerification: subscriptionThreeDSecureVerification,
        vaultThreeDSecureVerification,
      };
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        auditEventId = appendSubscriptionEvent({
          store,
          context: subscriptionContext,
          result,
          verification,
          endpoint: 'recurring/start',
        }).id;
      } catch (error) {
        logger.error('Stage 3 subscription audit persistence error:', error?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree returned a subscription result, but the local audit event could not be saved. Do not retry or run a follow-up action.',
        };
      }
      const payload = {
        success: result?.success === true && verification.passed,
        request: safeRequest,
        route: publicDecision(resolved.decision),
        recurringModel,
        transactionSource: null,
        scheduleOwner: 'braintree',
        vaultResult: vaultSummary,
        vaultVerification,
        threeDSecureVerification: subscriptionThreeDSecureVerification,
        vaultThreeDSecureVerification,
        subscription,
        verification,
        controlPanelUrl: buildSandboxSubscriptionUrl(merchantId, subscription?.id),
        auditEventId,
        audit,
        retrySafe: false,
      };
      if (result?.success !== true && !subscription) {
        throw new ApiProblem(
          422,
          'BRAINTREE_SUBSCRIPTION_FAILED',
          safeResultMessage(result, 'Braintree did not create the subscription.'),
          payload
        );
      }
      if (!verification.passed) {
        throw new ApiProblem(
          502,
          'ROUTE_VERIFICATION_FAILED',
          'Braintree returned the subscription on a different merchant account, currency, or plan. Do not retry.',
          payload
        );
      }
      if (result?.success !== true) {
        throw new ApiProblem(
          422,
          'BRAINTREE_SUBSCRIPTION_FAILED',
          safeResultMessage(result, 'Braintree did not create the subscription.'),
          payload
        );
      }
      return res.json(payload);
    } catch (error) {
      if (error instanceof ApiProblem) return sendProblem(res, error);

      logger.error('Stage 3 recurring start error:', error?.name ?? 'Error');
      if (routeContext && (vaultRequested || billingRequested)) {
        try {
          store.append({
            type: billingRequested
              ? routeContext.recurringModel === 'braintree_subscription'
                ? 'subscription'
                : 'transaction'
              : 'vault',
            stage: 3,
            endpoint: 'recurring/start',
            scenarioId: routeContext.scenarioId,
            intent: publicDecision(routeContext.decision).intent,
            resolvedMerchantAccountId: routeContext.decision.account.merchantAccountId,
            verified: false,
            paymentMethod: routeContext.paymentMethod,
            paymentMethodType: routeContext.paymentMethod === 'paypal'
              ? 'paypal_account'
              : 'credit_card',
            threeDSecurePolicy:
              routeContext.threeDSecureVerification?.policy ??
              routeContext.decision.account.threeDSecurePolicy,
            threeDSecureStatus:
              routeContext.threeDSecureVerification?.status ?? null,
            liabilityShiftPossible:
              routeContext.threeDSecureVerification?.liabilityShiftPossible ?? null,
            liabilityShifted:
              routeContext.threeDSecureVerification?.liabilityShifted ?? null,
            threeDSecureEvidenceScope:
              routeContext.threeDSecureVerification?.evidenceScope ?? null,
            transactionThreeDSecureAuthenticated:
              routeContext.threeDSecureVerification?.transactionAuthenticated ?? null,
            amount: routeContext.amount,
            currency: routeContext.decision.intent.currency,
            outcome: 'gateway_error',
            transactionSource:
              routeContext.recurringModel === 'merchant_managed' && billingRequested
                ? 'recurring_first'
                : null,
            recurringModel: routeContext.recurringModel,
            customerId,
            vaultEventId: vaultEvent?.id ?? null,
            planId: routeContext.plan?.id ?? null,
            request: routeContext.safeRequest,
            error: { name: error?.name ?? 'Error', code: error?.code ?? null },
            threeDSecureVerification:
              routeContext.threeDSecureVerification ?? null,
            vaultThreeDSecureVerification:
              routeContext.vaultThreeDSecureVerification ?? null,
          });
        } catch (auditError) {
          logger.error('Stage 3 ambiguous start audit error:', auditError?.name ?? 'Error');
        }
        return sendProblem(
          res,
          new ApiProblem(
            502,
            'BRAINTREE_REQUEST_OUTCOME_UNKNOWN',
            'Braintree did not return a usable result. Do not retry until the Sandbox Control Panel has been checked.',
            {
              request: routeContext.safeRequest,
              route: publicDecision(routeContext.decision),
              threeDSecureVerification:
                routeContext.threeDSecureVerification ?? null,
              vaultThreeDSecureVerification:
                routeContext.vaultThreeDSecureVerification ?? null,
              retrySafe: false,
            }
          )
        );
      }
      return sendProblem(res, error);
    }
  });

  async function runVaultedSale(req, res, { paymentType, transactionSource, billingCycle }) {
    let context;
    let decision;
    let threeDSecureVerification;
    let vaultThreeDSecureVerification = null;
    let operationRequested = false;
    try {
      requireEmptyActionBody(req);
      context = requireRecurringRoot(req.params.eventId, catalog(), store, {
        ...(paymentType === 'recurring' ? { model: 'merchant_managed' } : {}),
        allowSubscription: paymentType === 'one_time',
        requireSetupEvidence: paymentType === 'recurring',
      });
      if (paymentType === 'one_time' && context.paymentMethod === 'paypal') {
        throw new ApiProblem(
          422,
          'PAYPAL_VAULT_ONE_TIME_UNSUPPORTED',
          'This demo does not run a non-recurring PayPal vault charge without device-data collection.',
          { retrySafe: true }
        );
      }
      decision = resolveRoute({ currency: context.currency, paymentType }, context.accounts);
      if (!decision.matched) {
        throw new ApiProblem(422, 'NO_ROUTE', decision.reason, {
          route: publicDecision(decision),
          retrySafe: true,
        });
      }
      requireAvailablePaymentMethod(decision.account, context.paymentMethod);
      const persistedThreeDSecureVerification = verifyThreeDSecure({
        source: context.vaultThreeDSecureVerification ||
          context.threeDSecureVerification,
        policy: decision.account.threeDSecurePolicy,
        paymentMethod: context.paymentMethod,
      });
      if (paymentType === 'one_time') {
        vaultThreeDSecureVerification =
          vaultSetupThreeDSecureVerification(persistedThreeDSecureVerification);
        threeDSecureVerification = vaultedOneTimeThreeDSecureVerification({
          policy: decision.account.threeDSecurePolicy,
          paymentMethod: context.paymentMethod,
        });
        if (threeDSecureVerification.required) {
          throw new ApiProblem(
            422,
            'THREE_D_SECURE_FRESH_AUTHENTICATION_REQUIRED',
            'This one-time route requires a fresh 3D Secure authentication. Historical recurring-setup evidence cannot authorize a new charge; start a fresh checkout on this route. No transaction was requested.',
            {
              route: publicDecision(decision),
              threeDSecureVerification,
              vaultThreeDSecureVerification,
              retrySafe: true,
            }
          );
        }
      } else {
        threeDSecureVerification = context.paymentMethod === 'card'
          ? vaultSetupThreeDSecureVerification(persistedThreeDSecureVerification)
          : persistedThreeDSecureVerification;
        vaultThreeDSecureVerification = context.paymentMethod === 'card'
          ? threeDSecureVerification
          : null;
      }
      if (!threeDSecureVerification.passed) {
        throw new ApiProblem(
          422,
          'THREE_D_SECURE_REQUIRED_FOR_TARGET',
          'The newly selected account requires 3D Secure proof that is not present on this vaulted payment method. Start a fresh checkout on that route; no transaction was requested.',
          {
            route: publicDecision(decision),
            threeDSecureVerification,
            vaultThreeDSecureVerification,
            retrySafe: true,
          }
        );
      }
      const operationContext = {
        decision,
        scenarioId: context.scenarioId,
        amount: context.amount,
        recurringModel: context.recurringModel,
        customerId: context.customerId,
        vaultEventId: context.vaultEventId,
        paymentMethod: context.paymentMethod,
        threeDSecureVerification,
        vaultThreeDSecureVerification,
      };
      const request = {
        merchantAccountId: decision.account.merchantAccountId,
        amount: context.amount,
        customerId: context.customerId,
        orderId: makeOrderId(
          paymentType === 'recurring' ? 'demo-recurring-next' : 'demo-vault-one-time',
          context.scenarioId,
          now,
          generateId
        ),
        submitForSettlement: true,
        ...(transactionSource ? { transactionSource } : {}),
      };
      operationRequested = true;
      const result = await gateway().createSale(request);
      const verification = transactionRouteVerification(
        result,
        decision.account,
        context.paymentMethod
      );
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        auditEventId = appendTransactionEvent({
          store,
          context: operationContext,
          result,
          verification,
          transactionSource,
          billingCycle,
          endpoint: paymentType === 'recurring'
            ? 'recurring/events/next-cycle'
            : 'recurring/events/one-time',
          relatedEventId: context.root.id,
        }).id;
      } catch (error) {
        logger.error('Stage 3 recurring action audit error:', error?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree returned the payment result, but the local audit event could not be saved. Do not retry.',
        };
      }
      const payload = {
        success: result?.success === true && verification.passed,
        route: publicDecision(decision),
        recurringModel: context.recurringModel,
        paymentMethod: context.paymentMethod,
        transactionSource: transactionSource || null,
        ...(transactionSource ? {} : { vaultUsage: 'one_time_from_vault' }),
        braintreeResult: summarizeGatewayResult(result),
        verification,
        threeDSecureVerification,
        vaultThreeDSecureVerification,
        transactionStatus: result?.transaction?.status ?? null,
        controlPanelUrl: buildSandboxTransactionUrl(merchantId, result?.transaction?.id),
        auditEventId,
        audit,
        retrySafe: false,
      };
      if (result?.success !== true && !result?.transaction) {
        throw new ApiProblem(
          422,
          'BRAINTREE_RECURRING_FAILED',
          safeResultMessage(result, 'Braintree did not complete the vaulted payment.'),
          payload
        );
      }
      if (!verification.passed) {
        throw new ApiProblem(
          502,
          'ROUTE_VERIFICATION_FAILED',
          'Braintree returned the vaulted payment on a different merchant account or currency. Do not retry.',
          payload
        );
      }
      if (result?.success !== true) {
        throw new ApiProblem(
          422,
          'BRAINTREE_RECURRING_FAILED',
          safeResultMessage(result, 'Braintree did not complete the vaulted payment.'),
          payload
        );
      }
      return res.json(payload);
    } catch (error) {
      if (error instanceof ApiProblem) return sendProblem(res, error);
      logger.error('Stage 3 recurring action error:', error?.name ?? 'Error');
      if (operationRequested && context && decision) {
        try {
          store.append({
            type: 'transaction',
            stage: 3,
            endpoint: paymentType === 'recurring'
              ? 'recurring/events/next-cycle'
              : 'recurring/events/one-time',
            action: billingCycle,
            scenarioId: context.scenarioId,
            intent: { currency: context.currency, paymentType },
            resolvedMerchantAccountId: decision.account.merchantAccountId,
            verified: false,
            paymentMethod: context.paymentMethod,
            paymentMethodType: context.paymentMethod === 'paypal'
              ? 'paypal_account'
              : 'credit_card',
            threeDSecurePolicy: threeDSecureVerification?.policy ?? null,
            threeDSecureStatus: threeDSecureVerification?.status ?? null,
            liabilityShiftPossible:
              threeDSecureVerification?.liabilityShiftPossible ?? null,
            liabilityShifted: threeDSecureVerification?.liabilityShifted ?? null,
            threeDSecureEvidenceScope:
              threeDSecureVerification?.evidenceScope ?? null,
            transactionThreeDSecureAuthenticated:
              threeDSecureVerification?.transactionAuthenticated ?? null,
            amount: context.amount,
            currency: context.currency,
            outcome: 'gateway_error',
            transactionSource: transactionSource || null,
            recurringModel: context.recurringModel,
            billingCycle,
            customerId: context.customerId,
            vaultEventId: context.vaultEventId,
            relatedEventId: context.root.id,
            threeDSecureVerification: threeDSecureVerification ?? null,
            vaultThreeDSecureVerification,
          });
        } catch (auditError) {
          logger.error('Stage 3 ambiguous action audit error:', auditError?.name ?? 'Error');
        }
        return sendProblem(
          res,
          new ApiProblem(
            502,
            'BRAINTREE_REQUEST_OUTCOME_UNKNOWN',
            'Braintree did not return a usable payment result. Do not retry until the Sandbox Control Panel has been checked.',
            {
              threeDSecureVerification: threeDSecureVerification ?? null,
              vaultThreeDSecureVerification,
              retrySafe: false,
            }
          )
        );
      }
      return sendProblem(res, error);
    }
  }

  router.post('/events/:eventId/next-cycle', (req, res) =>
    runVaultedSale(req, res, {
      paymentType: 'recurring',
      transactionSource: 'recurring',
      billingCycle: 'subsequent',
    })
  );

  router.post('/events/:eventId/one-time', (req, res) =>
    runVaultedSale(req, res, {
      paymentType: 'one_time',
      transactionSource: null,
      billingCycle: 'one_time_from_vault',
    })
  );

  router.get('/subscriptions/:eventId', async (req, res) => {
    try {
      const context = requireSubscriptionRoot(req.params.eventId, catalog(), store);
      const subscription = await gateway().findSubscription({
        subscriptionId: context.subscriptionId,
        merchantAccountId: context.merchantAccountId,
      });
      const verification = subscriptionVerification(
        subscription,
        context.originalAccount,
        context.planId,
        context.paymentMethod
      );
      if (!verification.passed) {
        throw new ApiProblem(
          502,
          'ROUTE_VERIFICATION_FAILED',
          'The live subscription does not match its verified merchant account, currency evidence, or plan.',
          {
            subscription: summarizeSubscription(subscription),
            verification,
            retrySafe: true,
          }
        );
      }
      return res.json({
        success: true,
        recurringModel: 'braintree_subscription',
        paymentMethod: context.paymentMethod,
        transactionSource: null,
        scheduleOwner: 'braintree',
        subscription: summarizeSubscription(subscription),
        verification,
        threeDSecureVerification: context.threeDSecureVerification,
        vaultThreeDSecureVerification:
          context.vaultThreeDSecureVerification,
        controlPanelUrl: buildSandboxSubscriptionUrl(
          merchantId,
          context.subscriptionId
        ),
        retrySafe: true,
      });
    } catch (error) {
      if (!(error instanceof ApiProblem)) {
        logger.error('Stage 3 subscription status error:', error?.name ?? 'Error');
      }
      return sendProblem(res, error instanceof ApiProblem
        ? error
        : new ApiProblem(
            502,
            'BRAINTREE_REQUEST_FAILED',
            'Braintree could not return the live subscription status.',
            { retrySafe: true }
          ));
    }
  });

  router.post('/subscriptions/:eventId/cancel', async (req, res) => {
    let context;
    let operationRequested = false;
    try {
      requireEmptyActionBody(req);
      context = requireSubscriptionRoot(req.params.eventId, catalog(), store);
      operationRequested = true;
      const result = await gateway().cancelSubscription({
        subscriptionId: context.subscriptionId,
        merchantAccountId: context.merchantAccountId,
      });
      const verification = subscriptionVerification(
        result,
        context.originalAccount,
        context.planId,
        context.paymentMethod
      );
      const subscription = summarizeSubscription(result);
      const cancellationConfirmed = ['canceled', 'cancelled'].includes(
        String(subscription?.status || '').trim().toLowerCase()
      );
      let auditEventId = null;
      let audit = { persisted: true };
      try {
        auditEventId = appendSubscriptionEvent({
          store,
          context,
          result,
          verification,
          action: 'cancel',
          relatedEventId: context.root.id,
          endpoint: 'recurring/subscriptions/cancel',
        }).id;
      } catch (error) {
        logger.error('Stage 3 subscription cancel audit error:', error?.name ?? 'Error');
        audit = {
          persisted: false,
          warning:
            'Braintree returned the cancellation result, but the local audit event could not be saved. Do not retry.',
        };
      }
      const payload = {
        success:
          result?.success !== false && verification.passed && cancellationConfirmed,
        recurringModel: 'braintree_subscription',
        paymentMethod: context.paymentMethod,
        transactionSource: null,
        scheduleOwner: 'braintree',
        subscription,
        verification,
        threeDSecureVerification: context.threeDSecureVerification,
        vaultThreeDSecureVerification:
          context.vaultThreeDSecureVerification,
        cancellationConfirmed,
        controlPanelUrl: buildSandboxSubscriptionUrl(
          merchantId,
          context.subscriptionId
        ),
        auditEventId,
        audit,
        retrySafe: false,
      };
      if (result?.success === false && !subscription) {
        throw new ApiProblem(
          422,
          'BRAINTREE_SUBSCRIPTION_CANCEL_FAILED',
          safeResultMessage(result, 'Braintree did not cancel the subscription.'),
          payload
        );
      }
      if (!verification.passed) {
        throw new ApiProblem(
          502,
          'ROUTE_VERIFICATION_FAILED',
          'Braintree returned the canceled subscription on a different merchant account, currency, or plan. Do not retry.',
          payload
        );
      }
      if (result?.success === false) {
        throw new ApiProblem(
          422,
          'BRAINTREE_SUBSCRIPTION_CANCEL_FAILED',
          safeResultMessage(result, 'Braintree did not cancel the subscription.'),
          payload
        );
      }
      if (!cancellationConfirmed) {
        throw new ApiProblem(
          502,
          'SUBSCRIPTION_CANCELLATION_NOT_CONFIRMED',
          'Braintree returned a subscription, but its status does not confirm cancellation. Do not retry until the Sandbox Control Panel has been checked.',
          payload
        );
      }
      return res.json(payload);
    } catch (error) {
      if (error instanceof ApiProblem) return sendProblem(res, error);
      logger.error('Stage 3 subscription cancel error:', error?.name ?? 'Error');
      if (operationRequested && context) {
        try {
          store.append({
            type: 'subscription_action',
            stage: 3,
            action: 'cancel',
            endpoint: 'recurring/subscriptions/cancel',
            scenarioId: context.scenarioId,
            intent: { currency: context.currency, paymentType: 'recurring' },
            resolvedMerchantAccountId: context.merchantAccountId,
            verified: false,
            paymentMethod: context.paymentMethod,
            paymentMethodType: context.paymentMethod === 'paypal'
              ? 'paypal_account'
              : 'credit_card',
            threeDSecurePolicy:
              context.threeDSecureVerification?.policy ?? null,
            threeDSecureStatus:
              context.threeDSecureVerification?.status ?? null,
            liabilityShiftPossible:
              context.threeDSecureVerification?.liabilityShiftPossible ?? null,
            liabilityShifted:
              context.threeDSecureVerification?.liabilityShifted ?? null,
            threeDSecureEvidenceScope:
              context.threeDSecureVerification?.evidenceScope ?? null,
            transactionThreeDSecureAuthenticated:
              context.threeDSecureVerification?.transactionAuthenticated ?? null,
            amount: context.amount,
            currency: context.currency,
            outcome: 'gateway_error',
            recurringModel: 'braintree_subscription',
            customerId: context.customerId,
            vaultEventId: context.vaultEventId,
            planId: context.planId,
            subscriptionId: context.subscriptionId,
            relatedEventId: context.root.id,
            request: { action: 'cancel' },
            error: { name: error?.name ?? 'Error', code: error?.code ?? null },
            threeDSecureVerification:
              context.threeDSecureVerification ?? null,
            vaultThreeDSecureVerification:
              context.vaultThreeDSecureVerification ?? null,
          });
        } catch (auditError) {
          logger.error(
            'Stage 3 ambiguous subscription cancel audit error:',
            auditError?.name ?? 'Error'
          );
        }
      }
      return sendProblem(
        res,
        new ApiProblem(
          502,
          operationRequested
            ? 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN'
            : 'BRAINTREE_REQUEST_FAILED',
          operationRequested
            ? 'Braintree did not return a usable cancellation result. Do not retry until the Sandbox Control Panel has been checked.'
            : 'The subscription cancellation could not be started.',
          {
            ...(context ? {
              threeDSecureVerification:
                context.threeDSecureVerification ?? null,
              vaultThreeDSecureVerification:
                context.vaultThreeDSecureVerification ?? null,
            } : {}),
            retrySafe: !operationRequested,
          }
        )
      );
    }
  });

  return router;
}

const router = createDemoRecurringApiRouter();
router.ApiProblem = ApiProblem;
router.createDemoRecurringApiRouter = createDemoRecurringApiRouter;

module.exports = router;
module.exports.ApiProblem = ApiProblem;
module.exports.createDemoRecurringApiRouter = createDemoRecurringApiRouter;
