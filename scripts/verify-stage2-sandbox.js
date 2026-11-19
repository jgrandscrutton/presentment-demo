'use strict';

const dotenv = require('dotenv');

dotenv.config({ path: ['./config.env', '.env'], quiet: true });

const { configureCatalogService } = require('../config/merchant-accounts');
const {
  getConfiguredMerchantId,
  getGateway,
  getGatewayClient,
} = require('../lib/braintree/gateway');
const {
  summarizeGatewayResult,
  verifyMerchantAccount,
} = require('../lib/braintree/result');
const { createCatalogService } = require('../lib/catalog/service');
const {
  fromMinorUnits,
  getSandboxOutcomeAmount,
  getVerificationAmount,
  toMinorUnits,
} = require('../lib/currency');
const { append } = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const { resolveRoute } = require('../lib/routing/resolve-route');

let pendingGatewayMutation = null;

async function requestGatewayMutation({ label, transactionId = null, reference = null }, operation) {
  pendingGatewayMutation = { label, transactionId, reference };
  const result = await operation();
  pendingGatewayMutation.transactionId =
    result?.transaction?.id ?? result?.id ?? transactionId;
  return result;
}

function markGatewayMutationAudited() {
  pendingGatewayMutation = null;
}

function describePendingGatewayMutation(pending = pendingGatewayMutation) {
  if (!pending) return null;
  const identity = pending.transactionId
    ? ` Transaction: ${pending.transactionId}.`
    : pending.reference
      ? ` Request reference: ${pending.reference}.`
      : '';
  return (
    `A ${pending.label} request may have reached Braintree without a complete local audit.${identity} ` +
    'Do not rerun this verifier until that request has been checked in the Sandbox Control Panel.'
  );
}

function getPendingGatewayMutation() {
  return pendingGatewayMutation ? { ...pendingGatewayMutation } : null;
}

function assertRoutedResult(result, decision, currency, label, { success = true } = {}) {
  if (typeof result?.success !== 'boolean' || result.success !== success) {
    throw new Error(
      `${label} returned success=${String(result?.success)}: ` +
      `${summarizeGatewayResult(result).message || 'no Braintree message'}`
    );
  }

  const verification = verifyMerchantAccount(
    result,
    decision.account.merchantAccountId
  );
  if (!verification.passed) {
    throw new Error(
      `${label} route mismatch: expected ${verification.expectedMerchantAccountId}, ` +
      `received ${verification.actualMerchantAccountId || 'no account ID'}`
    );
  }
  if (result?.transaction?.currencyIsoCode !== currency) {
    throw new Error(
      `${label} currency mismatch: expected ${currency}, ` +
      `received ${result?.transaction?.currencyIsoCode || 'no currency'}`
    );
  }

  return verification;
}

function appendGatewayEvent(event, transactionId) {
  try {
    return append(event);
  } catch (error) {
    throw new Error(
      `Braintree returned transaction ${transactionId || 'without an ID'}, but its ` +
      'Stage 2 audit event could not be saved. Do not rerun this verifier until the event store is repaired.',
      { cause: error }
    );
  }
}

function appendTransaction({ scenarioId, decision, amount, result, outcome, transactionMode, expectedOutcome }) {
  const verification = verifyMerchantAccount(
    result,
    decision.account.merchantAccountId
  );
  return appendGatewayEvent({
    type: 'transaction',
    stage: 2,
    source: 'verify:stage2:sandbox',
    scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: result?.transaction?.paymentInstrumentType ?? 'credit_card',
    amount,
    currency: result?.transaction?.currencyIsoCode ?? decision.intent.currency,
    outcome,
    transactionStatus: result?.transaction?.status ?? null,
    transactionMode,
    expectedOutcome,
    braintreeId: result?.transaction?.id ?? null,
    response: summarizeGatewayResult(result),
    verification,
  }, result?.transaction?.id);
}

function appendAction({ root, action, decision, amount, result }) {
  const verification = verifyMerchantAccount(
    result,
    decision.account.merchantAccountId
  );
  return appendGatewayEvent({
    type: 'transaction_action',
    stage: 2,
    source: 'verify:stage2:sandbox',
    action,
    scenarioId: root.scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: result?.transaction?.paymentInstrumentType ?? 'credit_card',
    amount: amount ?? result?.transaction?.amount ?? null,
    currency: result?.transaction?.currencyIsoCode ?? decision.intent.currency,
    outcome: result?.success === true && verification.passed ? 'succeeded' : 'failed',
    transactionStatus: result?.transaction?.status ?? null,
    braintreeId: result?.transaction?.id ?? null,
    originalBraintreeId: root.braintreeId,
    relatedEventId: root.id,
    request: { action, ...(amount ? { amount } : {}) },
    response: summarizeGatewayResult(result),
    verification,
  }, result?.transaction?.id);
}

function lifecycleAmount(currency, variant) {
  const candidate = getVerificationAmount(currency, variant);
  const units = toMinorUnits(candidate, currency, { allowZero: false });
  return units > 1n ? candidate : fromMinorUnits(2n, currency);
}

async function verifyStage2Sandbox() {
  const merchantId = getConfiguredMerchantId();
  const catalogService = createCatalogService({
    gateway: getGateway(),
    merchantId,
    environment: 'sandbox',
  });
  configureCatalogService(catalogService);

  const state = await catalogService.refresh();
  if (state.status !== 'ok') {
    throw new Error(
      `Merchant account discovery failed: ${state.error?.message || 'no usable catalog was returned'}`
    );
  }

  const accounts = catalogService.getMerchantAccounts();
  const defaultAccount = accounts.find((account) => account.isDefault);
  const orderedCurrencies = [
    defaultAccount?.currency,
    ...new Set(accounts.map((account) => account.currency)),
  ].filter(Boolean);
  let decision;
  for (const currency of orderedCurrencies) {
    const candidate = resolveRoute({ currency, paymentType: 'one_time' }, accounts);
    if (candidate.matched) {
      decision = candidate;
      break;
    }
  }
  if (!decision?.matched) {
    throw new Error('No active one-time route is available for Stage 2 verification.');
  }

  const gateway = getGatewayClient();
  const currency = decision.intent.currency;
  const merchantAccountId = decision.account.merchantAccountId;
  const runId = Date.now();
  const rows = [];

  const authorizedAmount = lifecycleAmount(currency, 220);
  const authorizeOrderId = `routing-demo-stage2-authorize-${runId}`;
  const authorizedResult = await requestGatewayMutation({
    label: 'authorization',
    reference: authorizeOrderId,
  }, () => gateway.createSale({
    merchantAccountId,
    amount: authorizedAmount,
    paymentMethodNonce: 'fake-valid-nonce',
    orderId: authorizeOrderId,
    submitForSettlement: false,
  }));
  assertRoutedResult(authorizedResult, decision, currency, 'Authorization');
  if (authorizedResult.transaction.status !== 'authorized') {
    throw new Error(`Authorization returned unexpected status ${authorizedResult.transaction.status}`);
  }
  const authorizedRoot = appendTransaction({
    scenarioId: `verify-${currency.toLowerCase()}-authorize-only`,
    decision,
    amount: authorizedAmount,
    result: authorizedResult,
    outcome: 'authorized',
    transactionMode: 'authorize_only',
    expectedOutcome: 'approved',
  });
  markGatewayMutationAudited();

  const authorizedUnits = toMinorUnits(authorizedAmount, currency, { allowZero: false });
  const captureAmount = fromMinorUnits(authorizedUnits / 2n, currency);
  const captureResult = await requestGatewayMutation({
    label: 'partial capture',
    transactionId: authorizedResult.transaction.id,
  }, () => gateway.captureTransaction({
    merchantAccountId,
    transactionId: authorizedResult.transaction.id,
    amount: captureAmount,
  }));
  assertRoutedResult(captureResult, decision, currency, 'Partial capture');
  appendAction({
    root: authorizedRoot,
    action: 'capture',
    decision,
    amount: captureAmount,
    result: captureResult,
  });
  markGatewayMutationAudited();

  const settleResult = await requestGatewayMutation({
    label: 'Sandbox settlement',
    transactionId: authorizedResult.transaction.id,
  }, () => gateway.settleTransaction({
    merchantAccountId,
    transactionId: authorizedResult.transaction.id,
  }));
  assertRoutedResult(settleResult, decision, currency, 'Sandbox settlement');
  appendAction({
    root: authorizedRoot,
    action: 'settle',
    decision,
    result: settleResult,
  });
  markGatewayMutationAudited();

  const captureUnits = toMinorUnits(captureAmount, currency, { allowZero: false });
  const refundUnits = captureUnits > 1n ? captureUnits / 2n : captureUnits;
  const refundAmount = fromMinorUnits(refundUnits, currency);
  const refundResult = await requestGatewayMutation({
    label: 'partial refund',
    transactionId: authorizedResult.transaction.id,
  }, () => gateway.refundTransaction({
    merchantAccountId,
    transactionId: authorizedResult.transaction.id,
    amount: refundAmount,
  }));
  assertRoutedResult(refundResult, decision, currency, 'Partial refund');
  appendAction({
    root: authorizedRoot,
    action: 'refund',
    decision,
    amount: refundAmount,
    result: refundResult,
  });
  markGatewayMutationAudited();
  rows.push({
    scenario: 'authorize → partial capture → settle → partial refund',
    transactionId: authorizedResult.transaction.id,
    merchantAccountId,
    currency,
    result: 'verified',
  });

  const voidAmount = lifecycleAmount(currency, 320);
  const voidOrderId = `routing-demo-stage2-void-${runId}`;
  const voidAuthorization = await requestGatewayMutation({
    label: 'void-path authorization',
    reference: voidOrderId,
  }, () => gateway.createSale({
    merchantAccountId,
    amount: voidAmount,
    paymentMethodNonce: 'fake-valid-nonce',
    orderId: voidOrderId,
    submitForSettlement: false,
  }));
  assertRoutedResult(voidAuthorization, decision, currency, 'Void authorization');
  const voidRoot = appendTransaction({
    scenarioId: `verify-${currency.toLowerCase()}-void`,
    decision,
    amount: voidAmount,
    result: voidAuthorization,
    outcome: 'authorized',
    transactionMode: 'authorize_only',
    expectedOutcome: 'approved',
  });
  markGatewayMutationAudited();
  const voidResult = await requestGatewayMutation({
    label: 'void',
    transactionId: voidAuthorization.transaction.id,
  }, () => gateway.voidTransaction({
    merchantAccountId,
    transactionId: voidAuthorization.transaction.id,
  }));
  assertRoutedResult(voidResult, decision, currency, 'Void');
  appendAction({ root: voidRoot, action: 'void', decision, result: voidResult });
  markGatewayMutationAudited();
  rows.push({
    scenario: 'authorize → void',
    transactionId: voidAuthorization.transaction.id,
    merchantAccountId,
    currency,
    result: 'verified',
  });

  for (const expectedOutcome of ['processor_declined', 'gateway_rejected']) {
    const amount = getSandboxOutcomeAmount(currency, expectedOutcome);
    const orderId = `routing-demo-stage2-${expectedOutcome}-${runId}`;
    const result = await requestGatewayMutation({
      label: expectedOutcome.replace('_', ' '),
      reference: orderId,
    }, () => gateway.createSale({
      merchantAccountId,
      amount,
      paymentMethodNonce: 'fake-valid-nonce',
      orderId,
      submitForSettlement: true,
    }));
    assertRoutedResult(result, decision, currency, expectedOutcome, { success: false });
    const actualOutcome = result.transaction.gatewayRejectionReason
      ? 'gateway_rejected'
      : result.transaction.status;
    if (actualOutcome !== expectedOutcome) {
      throw new Error(`${expectedOutcome} returned unexpected outcome ${actualOutcome}`);
    }
    appendTransaction({
      scenarioId: `verify-${currency.toLowerCase()}-${expectedOutcome}`,
      decision,
      amount,
      result,
      outcome: `expected_${expectedOutcome}`,
      transactionMode: 'submit_for_settlement',
      expectedOutcome,
    });
    markGatewayMutationAudited();
    rows.push({
      scenario: expectedOutcome,
      transactionId: result.transaction.id,
      merchantAccountId,
      currency,
      result: 'observed as expected',
    });
  }

  console.table(rows);
  console.log(
    'Stage 2 Sandbox verification passed: lifecycle actions, route preservation, and expected declines were observed.'
  );
}

function reportVerificationFailure(error) {
  const safeError = redact(error);
  console.error(
    `Stage 2 Sandbox verification failed (${safeError.name || 'Error'}): ` +
    `${safeError.message || 'Unknown error'}`
  );
  const pendingWarning = describePendingGatewayMutation();
  if (pendingWarning) console.error(pendingWarning);
  process.exitCode = 1;
}

if (require.main === module) {
  verifyStage2Sandbox().catch(reportVerificationFailure);
}

module.exports = {
  assertRoutedResult,
  describePendingGatewayMutation,
  getPendingGatewayMutation,
  markGatewayMutationAudited,
  requestGatewayMutation,
  verifyStage2Sandbox,
};
