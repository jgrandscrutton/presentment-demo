'use strict';

const crypto = require('node:crypto');

const braintree = require('braintree');

const {
  getConfiguredMerchantId,
  getGateway,
  getGatewayClient,
} = require('../lib/braintree/gateway');
const {
  summarizeGatewayResult,
  summarizeVaultResult,
  verifyMerchantAccount,
  verifyVaultResult,
} = require('../lib/braintree/result');
const { createCatalogService } = require('../lib/catalog/service');
const { getVerificationAmount } = require('../lib/currency');
const { append: appendStoredEvent } = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const {
  IMPLEMENTED_PAYMENT_METHODS,
  paymentMethodFromInstrumentType,
  paymentMethodFromNonce,
} = require('../lib/payment-methods');
const { resolveRoute } = require('../lib/routing/resolve-route');

const SOURCE = 'verify:stage5:sandbox';
const PAYMENT_TYPES = Object.freeze(['one_time', 'recurring']);
const DEFAULT_TEST_NONCES = Object.freeze({
  one_time: Object.freeze({
    card: braintree.Test.Nonces.Transactable,
    paypal: braintree.Test.Nonces.PayPalOneTimePayment,
  }),
  recurring: Object.freeze({
    card: braintree.Test.Nonces.Transactable,
    paypal: braintree.Test.Nonces.PayPalBillingAgreement,
  }),
});

function buildVerificationCases(accounts) {
  if (!Array.isArray(accounts)) {
    throw new TypeError('A discovered merchant-account catalog is required.');
  }

  const intents = new Map();
  for (const account of accounts) {
    if (account?.status !== 'active' || !Array.isArray(account.paymentTypes)) continue;
    for (const paymentType of account.paymentTypes) {
      if (!PAYMENT_TYPES.includes(paymentType)) continue;
      const currency = typeof account.currency === 'string'
        ? account.currency.trim().toUpperCase()
        : '';
      if (!/^[A-Z]{3}$/.test(currency)) continue;
      intents.set(`${currency}:${paymentType}`, { currency, paymentType });
    }
  }

  const cases = [];
  for (const intent of [...intents.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency) ||
    PAYMENT_TYPES.indexOf(left.paymentType) - PAYMENT_TYPES.indexOf(right.paymentType)
  )) {
    const baseDecision = resolveRoute(intent, accounts);
    if (!baseDecision.matched) {
      throw new Error(`The catalog advertises ${intent.currency} ${intent.paymentType}, but it does not resolve.`);
    }

    const methods = Array.isArray(baseDecision.account.paymentMethods)
      ? baseDecision.account.paymentMethods
      : [];
    if (methods.length === 0) {
      throw new Error(
        `The routed account for ${intent.currency} ${intent.paymentType} has no enabled payment method.`
      );
    }

    for (const paymentMethod of methods) {
      if (!IMPLEMENTED_PAYMENT_METHODS.has(paymentMethod)) {
        throw new Error(`Enabled payment method ${String(paymentMethod)} is not implemented by the verifier.`);
      }
      const decision = resolveRoute({ ...intent, paymentMethod }, accounts);
      if (
        !decision.matched ||
        decision.account.merchantAccountId !== baseDecision.account.merchantAccountId
      ) {
        throw new Error(
          `Payment method ${paymentMethod} changed the ${intent.currency} ${intent.paymentType} route.`
        );
      }
      cases.push({ intent, paymentMethod, decision });
    }
  }

  return cases;
}

function requireNonce(testCase, nonces = DEFAULT_TEST_NONCES) {
  const nonce = nonces?.[testCase.intent.paymentType]?.[testCase.paymentMethod];
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    throw new Error(
      `No Sandbox nonce is configured for ${testCase.paymentMethod} ${testCase.intent.paymentType}.`
    );
  }
  return nonce;
}

function assertNonceMethod(nonceDetails, expectedPaymentMethod) {
  const actualPaymentMethod = paymentMethodFromNonce(nonceDetails);
  if (actualPaymentMethod !== expectedPaymentMethod) {
    throw new Error(
      `Sandbox nonce method mismatch: expected ${expectedPaymentMethod}, received ` +
      `${actualPaymentMethod || 'unverified payment method'}. No mutation was requested.`
    );
  }
  return {
    passed: true,
    expectedPaymentMethod,
    actualPaymentMethod,
  };
}

function verifyTransactionResult(result, decision, expectedPaymentMethod) {
  const route = verifyMerchantAccount(result, decision.account.merchantAccountId);
  const expectedCurrency = decision.intent.currency;
  const actualCurrency = typeof result?.transaction?.currencyIsoCode === 'string'
    ? result.transaction.currencyIsoCode.trim().toUpperCase()
    : null;
  const actualInstrumentType = typeof result?.transaction?.paymentInstrumentType === 'string'
    ? result.transaction.paymentInstrumentType.trim().toLowerCase()
    : null;
  const actualPaymentMethod = paymentMethodFromInstrumentType(actualInstrumentType);
  const currencyMatched = actualCurrency === expectedCurrency;
  const paymentMethodMatched = actualPaymentMethod === expectedPaymentMethod;
  const operationSucceeded = result?.success === true && Boolean(result?.transaction);
  const passed = operationSucceeded && route.passed && currencyMatched && paymentMethodMatched;

  return {
    passed,
    operationSucceeded,
    merchantAccountMatched: route.passed,
    currencyMatched,
    paymentMethodMatched,
    expectedMerchantAccountId: route.expectedMerchantAccountId,
    actualMerchantAccountId: route.actualMerchantAccountId,
    expectedCurrency,
    actualCurrency,
    expectedPaymentMethod,
    actualPaymentMethod,
    actualInstrumentType,
    explanation: passed
      ? 'Braintree returned the server-selected merchant account, currency, and payment method.'
      : 'The Braintree result did not prove the server-selected account, currency, and payment method.',
  };
}

function safeRunTag(now, randomId) {
  const time = Number(now());
  const timePart = Number.isFinite(time) ? Math.max(0, Math.floor(time)).toString(36) : 'time';
  const randomPart = String(randomId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'random';
  return `${timePart}-${randomPart}`;
}

function identifier(prefix, runTag, index, testCase, maximum) {
  const value = [
    prefix,
    runTag,
    String(index + 1),
    testCase.intent.currency.toLowerCase(),
    testCase.paymentMethod,
  ].join('-').replace(/[^A-Za-z0-9_-]/g, '-');
  return value.slice(0, maximum);
}

function scenarioId(testCase) {
  return [
    'verify-stage5',
    testCase.intent.currency.toLowerCase(),
    testCase.intent.paymentType.replaceAll('_', '-'),
    testCase.paymentMethod,
  ].join('-');
}

function selectVerificationCases(cases, scenarioIds) {
  if (scenarioIds === null || scenarioIds === undefined) return cases;
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    throw new TypeError('scenarioIds must be a non-empty array when provided.');
  }

  const requested = new Set();
  for (const value of scenarioIds) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) throw new TypeError('Every selected scenario ID must be a non-empty string.');
    if (requested.has(id)) throw new Error(`Scenario ${id} was selected more than once.`);
    requested.add(id);
  }

  const available = new Set(cases.map((testCase) => scenarioId(testCase)));
  const unknown = [...requested].filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown Stage 5 verification scenario: ${unknown.join(', ')}.`);
  }

  return cases.filter((testCase) => requested.has(scenarioId(testCase)));
}

function parseVerifierArguments(args) {
  if (!Array.isArray(args)) throw new TypeError('CLI arguments must be an array.');
  const scenarioIds = [];
  let allowMockedPayPal = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-mocked-paypal') {
      if (allowMockedPayPal) {
        throw new Error('--allow-mocked-paypal was provided more than once.');
      }
      allowMockedPayPal = true;
      continue;
    }
    if (argument !== '--scenario') {
      throw new Error(`Unknown Stage 5 verifier argument: ${String(argument)}.`);
    }
    const scenario = args[index + 1];
    if (typeof scenario !== 'string' || scenario.trim() === '') {
      throw new Error('--scenario requires a scenario ID.');
    }
    scenarioIds.push(scenario.trim());
    index += 1;
  }
  return {
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : null,
    allowMockedPayPal,
  };
}

function parseScenarioArguments(args) {
  return parseVerifierArguments(args).scenarioIds;
}

function assertPayPalSandboxStrategy(cases, { allowMockedPayPal = false } = {}) {
  if (!cases.some((testCase) => testCase.paymentMethod === 'paypal')) return;
  if (allowMockedPayPal === true) return;

  throw new Error(
    'PayPal scenarios require fresh browser-generated Sandbox nonces when the Braintree ' +
    'Sandbox is linked to PayPal. Static fake PayPal nonces can stop working after linking. ' +
    'Select card-only scenarios, complete PayPal proof through the demo UI, or use ' +
    '--allow-mocked-paypal only with Braintree mocked PayPal testing. No mutation was requested.'
  );
}

function appendRouteEvent({ appendEvent, testCase, amount }) {
  return appendEvent({
    type: 'route_resolution',
    stage: 5,
    source: SOURCE,
    scenarioId: scenarioId(testCase),
    intent: testCase.decision.intent,
    resolvedMerchantAccountId: testCase.decision.account.merchantAccountId,
    paymentMethod: testCase.paymentMethod,
    paymentMethodType: testCase.paymentMethod,
    amount,
    currency: testCase.intent.currency,
    outcome: 'matched',
    route: testCase.decision,
  });
}

function appendCompletedMutation(appendEvent, event, operationLabel) {
  try {
    return appendEvent(event);
  } catch (error) {
    throw new Error(
      `Braintree completed ${operationLabel}, but its Stage 5 audit event could not be saved. ` +
      'Do not repeat this operation until the Sandbox Control Panel has been checked.',
      { cause: error }
    );
  }
}

async function requestMutation(operationLabel, reference, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(
      `Braintree may have received ${operationLabel} (${reference}). Do not retry until the ` +
      'Sandbox Control Panel has been checked.',
      { cause: error }
    );
  }
}

function transactionEvent({
  testCase,
  amount,
  result,
  verification,
  customerId = null,
  vaultEventId = null,
  transactionSource = null,
}) {
  return {
    type: 'transaction',
    stage: 5,
    source: SOURCE,
    scenarioId: scenarioId(testCase),
    intent: testCase.decision.intent,
    resolvedMerchantAccountId: testCase.decision.account.merchantAccountId,
    responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: testCase.paymentMethod,
    responsePaymentInstrumentType:
      result?.transaction?.paymentInstrumentType ?? null,
    amount: result?.transaction?.amount ?? amount,
    currency: result?.transaction?.currencyIsoCode ?? testCase.intent.currency,
    outcome: verification.passed ? 'succeeded' : 'failed',
    transactionStatus: result?.transaction?.status ?? null,
    transactionSource,
    recurringModel: testCase.intent.paymentType === 'recurring'
      ? 'merchant_managed'
      : null,
    billingCycle: testCase.intent.paymentType === 'recurring' ? 'first' : null,
    customerId,
    vaultEventId,
    braintreeId: result?.transaction?.id ?? null,
    request: {
      paymentMethod: testCase.paymentMethod,
      submitForSettlement: true,
      ...(customerId ? { customerId } : {}),
      ...(transactionSource ? { transactionSource } : {}),
    },
    response: summarizeGatewayResult(result),
    verification,
  };
}

function requireSuccessfulProof(result, verification, label) {
  if (!verification.passed) {
    const transactionId = result?.transaction?.id;
    const failures = [];
    if (!verification.operationSucceeded) {
      const message = typeof result?.message === 'string' && result.message.trim()
        ? `: ${result.message.trim()}`
        : '';
      failures.push(`gateway operation did not succeed${message}`);
    }
    if (!verification.merchantAccountMatched) failures.push('merchant account mismatch');
    if (!verification.currencyMatched) failures.push('currency mismatch');
    if (!verification.paymentMethodMatched) failures.push('payment method mismatch');
    throw new Error(
      `${label} failed verification (${failures.join('; ') || 'unverified result'})` +
      `${transactionId ? ` for transaction ${transactionId}` : ''}. Do not retry this operation.`
    );
  }
}

async function verifyOneTimeCase({
  gateway,
  appendEvent,
  testCase,
  nonce,
  amount,
  runTag,
  index,
}) {
  const orderId = identifier('stage5-one-time', runTag, index, testCase, 255);
  const result = await requestMutation(
    `${testCase.paymentMethod} one-time sale`,
    `order ${orderId}`,
    () => gateway.createSale({
      merchantAccountId: testCase.decision.account.merchantAccountId,
      amount,
      paymentMethodNonce: nonce,
      orderId,
      submitForSettlement: true,
    })
  );
  const verification = verifyTransactionResult(
    result,
    testCase.decision,
    testCase.paymentMethod
  );
  const event = appendCompletedMutation(
    appendEvent,
    transactionEvent({ testCase, amount, result, verification }),
    `${testCase.paymentMethod} one-time sale`
  );
  requireSuccessfulProof(result, verification, `${testCase.paymentMethod} one-time sale`);
  return { event, result, verification };
}

async function verifyRecurringCase({
  gateway,
  appendEvent,
  testCase,
  nonce,
  amount,
  runTag,
  index,
}) {
  const customerId = identifier('demo-s5', runTag, index, testCase, 36);
  const rawVaultResult = await requestMutation(
    `${testCase.paymentMethod} vault creation`,
    `customer ${customerId}`,
    () => gateway.createVaultedCustomer({
      customerId,
      paymentMethodNonce: nonce,
      merchantAccountId: testCase.decision.account.merchantAccountId,
      paymentMethod: testCase.paymentMethod,
    })
  );
  const vaultSummary = summarizeVaultResult(rawVaultResult);
  const vaultVerification = verifyVaultResult(
    rawVaultResult,
    testCase.decision.account,
    testCase.paymentMethod
  );
  const vaultEvent = appendCompletedMutation(appendEvent, {
    type: 'vault',
    stage: 5,
    source: SOURCE,
    scenarioId: scenarioId(testCase),
    intent: testCase.decision.intent,
    resolvedMerchantAccountId: testCase.decision.account.merchantAccountId,
    responseMerchantAccountId: vaultVerification.actualMerchantAccountId ?? null,
    verified: vaultVerification.routeVerified === false
      ? false
      : vaultVerification.passed,
    paymentMethodVerified: vaultVerification.passed,
    routeVerificationDeferred: vaultVerification.routeVerified === false,
    paymentMethod: testCase.paymentMethod,
    paymentMethodType: testCase.paymentMethod,
    amount: vaultSummary.verification?.amount ?? null,
    currency: vaultVerification.actualCurrency ?? testCase.intent.currency,
    outcome: vaultVerification.passed ? 'succeeded' : 'failed',
    customerId,
    request: {
      customerId,
      paymentMethod: testCase.paymentMethod,
      ...(testCase.paymentMethod === 'card'
        ? {
            verifyCard: true,
            verificationMerchantAccountId:
              testCase.decision.account.merchantAccountId,
          }
        : {}),
    },
    response: vaultSummary,
    verification: vaultVerification,
  }, `${testCase.paymentMethod} vault creation`);

  if (!vaultVerification.passed) {
    throw new Error(
      `${testCase.paymentMethod} vault creation did not return safe payment-method proof. ` +
      'Do not repeat the vault operation.'
    );
  }

  const orderId = identifier('stage5-recurring-first', runTag, index, testCase, 255);
  const result = await requestMutation(
    `${testCase.paymentMethod} first recurring sale`,
    `order ${orderId}`,
    () => gateway.createSale({
      merchantAccountId: testCase.decision.account.merchantAccountId,
      amount,
      customerId,
      orderId,
      submitForSettlement: true,
      transactionSource: 'recurring_first',
    })
  );
  const verification = verifyTransactionResult(
    result,
    testCase.decision,
    testCase.paymentMethod
  );
  const event = appendCompletedMutation(
    appendEvent,
    transactionEvent({
      testCase,
      amount,
      result,
      verification,
      customerId,
      vaultEventId: vaultEvent.id,
      transactionSource: 'recurring_first',
    }),
    `${testCase.paymentMethod} first recurring sale`
  );
  requireSuccessfulProof(result, verification, `${testCase.paymentMethod} first recurring sale`);
  return { event, result, verification, vaultEvent, vaultVerification };
}

async function verifyCase({
  gateway,
  appendEvent,
  testCase,
  nonces = DEFAULT_TEST_NONCES,
  amount,
  runTag,
  index = 0,
}) {
  const nonce = requireNonce(testCase, nonces);
  const nonceDetails = await gateway.inspectPaymentMethodNonce({
    paymentMethodNonce: nonce,
  });
  const nonceVerification = assertNonceMethod(nonceDetails, testCase.paymentMethod);
  appendRouteEvent({ appendEvent, testCase, amount });

  const result = testCase.intent.paymentType === 'recurring'
    ? await verifyRecurringCase({
        gateway,
        appendEvent,
        testCase,
        nonce,
        amount,
        runTag,
        index,
      })
    : await verifyOneTimeCase({
        gateway,
        appendEvent,
        testCase,
        nonce,
        amount,
        runTag,
        index,
      });

  return { ...result, nonceVerification };
}

async function verifyStage5Routes({
  accounts,
  gateway,
  appendEvent = appendStoredEvent,
  nonces = DEFAULT_TEST_NONCES,
  amountFor = getVerificationAmount,
  now = () => Date.now(),
  randomId = () => crypto.randomBytes(4).toString('hex'),
  scenarioIds = null,
} = {}) {
  if (
    !gateway ||
    typeof gateway.inspectPaymentMethodNonce !== 'function' ||
    typeof gateway.createSale !== 'function' ||
    typeof gateway.createVaultedCustomer !== 'function'
  ) {
    throw new TypeError('A Stage 5 capable Braintree gateway client is required.');
  }
  if (typeof appendEvent !== 'function' || typeof amountFor !== 'function') {
    throw new TypeError('Event persistence and amount selection functions are required.');
  }

  const cases = selectVerificationCases(buildVerificationCases(accounts), scenarioIds);
  if (cases.length === 0) {
    throw new Error('No active routed payment-method combinations were discovered.');
  }
  const runTag = safeRunTag(now, randomId);
  const rows = [];

  for (const [index, testCase] of cases.entries()) {
    const amount = amountFor(testCase.intent.currency, 500 + index);
    const verified = await verifyCase({
      gateway,
      appendEvent,
      testCase,
      nonces,
      amount,
      runTag,
      index,
    });
    rows.push({
      route: `${testCase.intent.currency} ${testCase.intent.paymentType}`,
      method: testCase.paymentMethod,
      selectedAccount: testCase.decision.account.merchantAccountId,
      returnedAccount: verified.result.transaction.merchantAccountId,
      transactionId: verified.result.transaction.id,
      status: verified.result.transaction.status,
      verified: 'yes',
    });
  }

  return { cases, rows, runTag };
}

function sensitiveValues() {
  return new Set([
    ...Object.values(DEFAULT_TEST_NONCES.one_time),
    ...Object.values(DEFAULT_TEST_NONCES.recurring),
    ...['MERCHANT_ID', 'PUBLIC_KEY', 'PRIVATE_KEY']
      .map((name) => process.env[name])
      .filter((value) => typeof value === 'string' && value.trim() !== ''),
  ]);
}

function safeErrorText(value) {
  let text = String(value ?? 'Unknown error');
  for (const sensitive of sensitiveValues()) {
    text = text.split(sensitive).join('[REDACTED]');
  }
  return redact(text);
}

async function verifyStage5Sandbox({
  scenarioIds = null,
  allowMockedPayPal = false,
} = {}) {
  const dotenv = require('dotenv');
  dotenv.config({ path: ['./config.env', '.env'], quiet: true });

  const { configureCatalogService } = require('../config/merchant-accounts');
  const merchantId = getConfiguredMerchantId();
  const rawGateway = getGateway();
  const catalogService = createCatalogService({
    gateway: rawGateway,
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
  const selectedCases = selectVerificationCases(
    buildVerificationCases(accounts),
    scenarioIds
  );
  assertPayPalSandboxStrategy(selectedCases, { allowMockedPayPal });

  const verification = await verifyStage5Routes({
    accounts,
    gateway: getGatewayClient(),
    scenarioIds,
  });

  console.log('Stage 5 routed payment-method verification:');
  console.table(verification.rows);
  console.log(
    `Sandbox verification passed for ${verification.rows.length} routed account/method ` +
    `${verification.rows.length === 1 ? 'combination' : 'combinations'}. ` +
    'Clearly labelled transactions and recurring demo customers remain in Sandbox.'
  );
  return verification;
}

if (require.main === module) {
  let options;
  try {
    options = parseVerifierArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Stage 5 Sandbox verification failed (Error): ${safeErrorText(error?.message)}`);
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) verifyStage5Sandbox(options).catch((error) => {
    const name = typeof error?.name === 'string' ? error.name : 'Error';
    console.error(`Stage 5 Sandbox verification failed (${name}): ${safeErrorText(error?.message)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TEST_NONCES,
  assertNonceMethod,
  assertPayPalSandboxStrategy,
  buildVerificationCases,
  parseVerifierArguments,
  parseScenarioArguments,
  selectVerificationCases,
  verifyCase,
  verifyStage5Routes,
  verifyStage5Sandbox,
  verifyTransactionResult,
};
