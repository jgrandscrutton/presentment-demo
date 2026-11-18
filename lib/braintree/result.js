'use strict';

const { REDACTED, redact } = require('../inspector/redact');
const {
  PAYMENT_METHOD_CARD,
  PAYMENT_METHOD_PAYPAL,
} = require('../payment-methods');
const { extractThreeDSecureInfo } = require('../three-d-secure');

const SAFE_TRANSACTION_FIELDS = [
  'id',
  'status',
  'type',
  'amount',
  'currencyIsoCode',
  'merchantAccountId',
  'orderId',
  'paymentInstrumentType',
  'processorAuthorizationCode',
  'processorResponseCode',
  'processorResponseText',
  'processorSettlementResponseCode',
  'processorSettlementResponseText',
  'networkResponseCode',
  'networkResponseText',
  'gatewayRejectionReason',
  'avsErrorResponseCode',
  'avsPostalCodeResponseCode',
  'avsStreetAddressResponseCode',
  'cvvResponseCode',
  'createdAt',
  'updatedAt',
  'refundIds',
  'refundedTransactionId',
];

const SAFE_CARD_FIELDS = [
  'cardType',
  'last4',
  'maskedNumber',
  'default',
  'createdAt',
  'updatedAt',
];

const SAFE_CARD_VERIFICATION_FIELDS = [
  'id',
  'status',
  'amount',
  'currencyIsoCode',
  'merchantAccountId',
  'processorResponseCode',
  'processorResponseText',
  'processorResponseType',
  'networkResponseCode',
  'networkResponseText',
  'gatewayRejectionReason',
  'avsErrorResponseCode',
  'avsPostalCodeResponseCode',
  'avsStreetAddressResponseCode',
  'cvvResponseCode',
  'createdAt',
];

const SAFE_SUBSCRIPTION_FIELDS = [
  'id',
  'merchantAccountId',
  'status',
  'planId',
  'price',
  'balance',
  'billingDayOfMonth',
  'billingPeriodStartDate',
  'billingPeriodEndDate',
  'currentBillingCycle',
  'numberOfBillingCycles',
  'daysPastDue',
  'failureCount',
  'firstBillingDate',
  'nextBillingDate',
  'nextBillingPeriodAmount',
  'neverExpires',
  'paidThroughDate',
  'trialDuration',
  'trialDurationUnit',
  'trialPeriod',
  'createdAt',
  'updatedAt',
];

function serializeValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function summarizeDiagnosticText(value) {
  if (typeof value !== 'string') return null;

  return redact(value).replace(
    /((?:(?:payment[ _-]?method|vault)[ _-]?token|token)\s*(?::|=|\bis\b)\s*)[^\s,;}]+/gi,
    REDACTED
  );
}

function summarizeTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return null;
  }

  const summary = Object.fromEntries(
    SAFE_TRANSACTION_FIELDS
      .filter((field) => transaction[field] !== undefined && transaction[field] !== null)
      .map((field) => [field, serializeValue(transaction[field])])
  );
  const threeDSecureInfo = extractThreeDSecureInfo(transaction.threeDSecureInfo);
  if (threeDSecureInfo) summary.threeDSecureInfo = { ...threeDSecureInfo };

  return redact(summary);
}

function pickSafeFields(value, fields) {
  if (!value || typeof value !== 'object') return null;

  return redact(Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined && value[field] !== null)
      .map((field) => [field, serializeValue(value[field])])
  ));
}

function getCustomer(resultOrCustomer) {
  if (resultOrCustomer?.customer && typeof resultOrCustomer.customer === 'object') {
    return resultOrCustomer.customer;
  }

  if (
    resultOrCustomer &&
    typeof resultOrCustomer === 'object' &&
    (
      Array.isArray(resultOrCustomer.creditCards) ||
      Array.isArray(resultOrCustomer.paypalAccounts) ||
      Array.isArray(resultOrCustomer.paymentMethods)
    )
  ) {
    return resultOrCustomer;
  }

  return null;
}

function getPaymentMethod(resultOrCustomer, customer = getCustomer(resultOrCustomer)) {
  for (const candidate of [
    resultOrCustomer?.paymentMethod,
    resultOrCustomer?.creditCard,
    resultOrCustomer?.paypalAccount,
  ]) {
    if (candidate && typeof candidate === 'object') return candidate;
  }

  const paymentMethods = [
    ...(Array.isArray(customer?.creditCards) ? customer.creditCards : []),
    ...(Array.isArray(customer?.paypalAccounts) ? customer.paypalAccounts : []),
    ...(Array.isArray(customer?.paymentMethods) ? customer.paymentMethods : []),
  ].filter((candidate) => candidate && typeof candidate === 'object');

  return paymentMethods.find((candidate) => candidate.default === true) ||
    paymentMethods[0] ||
    null;
}

function getVaultPaymentMethodInfo(resultOrCustomer) {
  const customer = getCustomer(resultOrCustomer);
  if (resultOrCustomer?.paypalAccount && typeof resultOrCustomer.paypalAccount === 'object') {
    return { paymentMethod: resultOrCustomer.paypalAccount, type: PAYMENT_METHOD_PAYPAL };
  }
  if (resultOrCustomer?.creditCard && typeof resultOrCustomer.creditCard === 'object') {
    return { paymentMethod: resultOrCustomer.creditCard, type: PAYMENT_METHOD_CARD };
  }

  const paypalAccounts = Array.isArray(customer?.paypalAccounts)
    ? customer.paypalAccounts.filter((candidate) => candidate && typeof candidate === 'object')
    : [];
  const creditCards = Array.isArray(customer?.creditCards)
    ? customer.creditCards.filter((candidate) => candidate && typeof candidate === 'object')
    : [];
  const selectedPayPal = paypalAccounts.find((candidate) => candidate.default === true) ||
    paypalAccounts[0];
  const selectedCard = creditCards.find((candidate) => candidate.default === true) ||
    creditCards[0];
  if (selectedPayPal && !selectedCard) {
    return { paymentMethod: selectedPayPal, type: PAYMENT_METHOD_PAYPAL };
  }
  if (selectedCard) {
    return { paymentMethod: selectedCard, type: PAYMENT_METHOD_CARD };
  }

  const paymentMethod = getPaymentMethod(resultOrCustomer, customer);
  const constructorName = paymentMethod?.constructor?.name;
  const explicitType = String(
    paymentMethod?.paymentInstrumentType || paymentMethod?.type || ''
  ).trim().toLowerCase();
  const type = constructorName === 'PayPalAccount' ||
    explicitType === PAYMENT_METHOD_PAYPAL ||
    explicitType === 'paypal_account'
    ? PAYMENT_METHOD_PAYPAL
    : paymentMethod
      ? PAYMENT_METHOD_CARD
      : null;
  return { paymentMethod, type };
}

function getCardVerification(resultOrCustomer) {
  for (const candidate of [
    resultOrCustomer?.verification,
    resultOrCustomer?.creditCardVerification,
  ]) {
    if (candidate && typeof candidate === 'object') return candidate;
  }

  const customer = getCustomer(resultOrCustomer);
  const paymentMethod = getPaymentMethod(resultOrCustomer, customer);
  if (paymentMethod?.verification && typeof paymentMethod.verification === 'object') {
    return paymentMethod.verification;
  }

  const paymentMethods = [
    ...(Array.isArray(customer?.creditCards) ? customer.creditCards : []),
    ...(Array.isArray(customer?.paymentMethods) ? customer.paymentMethods : []),
  ];
  return paymentMethods.find(
    (candidate) => candidate?.verification && typeof candidate.verification === 'object'
  )?.verification || null;
}

function summarizeCardVerification(verification) {
  return pickSafeFields(verification, SAFE_CARD_VERIFICATION_FIELDS);
}

function summarizeVaultResult(result) {
  const customer = getCustomer(result);
  const { paymentMethod, type } = getVaultPaymentMethodInfo(result);
  const directResult = result && typeof result === 'object';
  const inferredSuccess = Boolean(customer || paymentMethod);

  return {
    success: typeof result?.success === 'boolean' ? result.success : inferredSuccess,
    message: summarizeDiagnosticText(result?.message),
    customer: customer
      ? pickSafeFields(customer, ['id', 'createdAt', 'updatedAt'])
      : null,
    paymentMethod: type === PAYMENT_METHOD_PAYPAL
      ? {
          type: PAYMENT_METHOD_PAYPAL,
          ...(pickSafeFields(paymentMethod, ['default', 'createdAt', 'updatedAt']) || {}),
        }
      : summarizeCardPaymentMethod(paymentMethod),
    verification: type === PAYMENT_METHOD_PAYPAL
      ? null
      : summarizeCardVerification(getCardVerification(result)),
    validationErrors: summarizeValidationErrors(directResult ? result.errors : null),
  };
}

function summarizeCardPaymentMethod(paymentMethod) {
  return pickSafeFields(paymentMethod, SAFE_CARD_FIELDS);
}

function normalizeCurrency(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().toUpperCase()
    : null;
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function verifyVaultResult(result, expectedAccount, paymentMethod = PAYMENT_METHOD_CARD) {
  if (paymentMethod === PAYMENT_METHOD_PAYPAL) {
    const methodInfo = getVaultPaymentMethodInfo(result);
    const operationSucceeded = result?.success === true;
    const methodMatched = methodInfo.type === PAYMENT_METHOD_PAYPAL;
    const tokenPresent = Boolean(normalizeIdentifier(methodInfo.paymentMethod?.token));
    const expectedMerchantAccountId = normalizeIdentifier(
      expectedAccount?.merchantAccountId
    );
    const expectedCurrency = normalizeCurrency(
      expectedAccount?.currency ?? expectedAccount?.currencyIsoCode
    );
    const passed = operationSucceeded && methodMatched && tokenPresent;

    return {
      passed,
      paymentMethod: PAYMENT_METHOD_PAYPAL,
      methodVerified: passed,
      routeVerified: false,
      operationSucceeded,
      methodMatched,
      tokenPresent,
      merchantAccountMatched: null,
      currencyMatched: null,
      expectedMerchantAccountId,
      actualMerchantAccountId: null,
      expectedCurrency,
      actualCurrency: null,
      routeEvidence: 'deferred_to_billing',
      explanation: passed
        ? 'Braintree vaulted the PayPal account; merchant-account and currency proof is deferred to the first billing result.'
        : 'Braintree did not return proof of a successfully vaulted PayPal payment method.',
    };
  }

  const verification = getCardVerification(result);
  const actualStatus = normalizeIdentifier(verification?.status)?.toLowerCase() || null;
  const actualMerchantAccountId = normalizeIdentifier(verification?.merchantAccountId);
  const actualCurrency = normalizeCurrency(verification?.currencyIsoCode);
  const expectedMerchantAccountId = normalizeIdentifier(
    expectedAccount?.merchantAccountId
  );
  const expectedCurrency = normalizeCurrency(
    expectedAccount?.currency ?? expectedAccount?.currencyIsoCode
  );
  const operationSucceeded = result?.success === true;
  const statusVerified = actualStatus === 'verified';
  const merchantAccountMatched = Boolean(
    expectedMerchantAccountId && actualMerchantAccountId === expectedMerchantAccountId
  );
  const currencyMatched = Boolean(
    expectedCurrency && actualCurrency === expectedCurrency
  );
  const passed = operationSucceeded &&
    statusVerified &&
    merchantAccountMatched &&
    currencyMatched;

  return {
    passed,
    operationSucceeded,
    statusVerified,
    merchantAccountMatched,
    currencyMatched,
    actualStatus,
    expectedMerchantAccountId,
    actualMerchantAccountId,
    expectedCurrency,
    actualCurrency,
    explanation: passed
      ? 'Braintree vaulted and verified the card on the selected merchant account and currency.'
      : 'The vault operation, card verification status, merchant account, or currency did not match the selected route.',
  };
}

function getSubscription(subscriptionOrResult) {
  if (
    subscriptionOrResult?.subscription &&
    typeof subscriptionOrResult.subscription === 'object'
  ) {
    return subscriptionOrResult.subscription;
  }

  if (
    subscriptionOrResult &&
    typeof subscriptionOrResult === 'object' &&
    (
      Object.hasOwn(subscriptionOrResult, 'merchantAccountId') ||
      Object.hasOwn(subscriptionOrResult, 'planId') ||
      Array.isArray(subscriptionOrResult.transactions)
    )
  ) {
    return subscriptionOrResult;
  }

  return null;
}

function summarizeSubscription(subscriptionOrResult) {
  const subscription = getSubscription(subscriptionOrResult);
  if (!subscription) return null;

  const summary = Object.fromEntries(
    SAFE_SUBSCRIPTION_FIELDS
      .filter((field) => subscription[field] !== undefined && subscription[field] !== null)
      .map((field) => [field, serializeValue(subscription[field])])
  );

  if (Array.isArray(subscription.transactions)) {
    summary.transactions = subscription.transactions
      .map(summarizeTransaction)
      .filter(Boolean);
  }

  return redact(summary);
}

function verifySubscriptionRoute(subscriptionOrResult, expectedAccount) {
  const subscription = getSubscription(subscriptionOrResult);
  const expectedMerchantAccountId = normalizeIdentifier(
    expectedAccount?.merchantAccountId
  );
  const expectedCurrency = normalizeCurrency(
    expectedAccount?.currency ?? expectedAccount?.currencyIsoCode
  );
  const actualMerchantAccountId = normalizeIdentifier(subscription?.merchantAccountId);
  const transactions = Array.isArray(subscription?.transactions)
    ? subscription.transactions
    : [];
  const transactionMerchantAccountIds = transactions.map(
    (transaction) => normalizeIdentifier(transaction?.merchantAccountId)
  );
  const transactionCurrencies = transactions.map(
    (transaction) => normalizeCurrency(transaction?.currencyIsoCode)
  );
  const merchantAccountMatched = Boolean(
    subscription &&
    expectedMerchantAccountId &&
    actualMerchantAccountId === expectedMerchantAccountId
  );
  const transactionMerchantAccountsMatched = transactions.every(
    (_transaction, index) =>
      Boolean(expectedMerchantAccountId) &&
      transactionMerchantAccountIds[index] === expectedMerchantAccountId
  );
  const transactionCurrenciesMatched = Boolean(expectedCurrency) && transactions.every(
    (_transaction, index) => transactionCurrencies[index] === expectedCurrency
  );
  const passed = merchantAccountMatched &&
    transactionMerchantAccountsMatched &&
    transactionCurrenciesMatched;

  return {
    passed,
    merchantAccountMatched,
    transactionMerchantAccountsMatched,
    transactionCurrenciesMatched,
    currencyEvidenceAvailable: transactions.length > 0,
    expectedMerchantAccountId,
    actualMerchantAccountId,
    expectedCurrency,
    transactionMerchantAccountIds,
    transactionCurrencies,
    explanation: passed
      ? transactions.length > 0
        ? 'Braintree returned the selected merchant account and matching transaction currencies.'
        : 'Braintree returned the selected merchant account; no subscription transaction exists yet.'
      : 'The subscription merchant account or a returned transaction did not match the selected route.',
  };
}

function summarizeValidationErrors(errors) {
  if (!errors) {
    return [];
  }

  let entries = [];

  if (typeof errors.deepErrors === 'function') {
    try {
      entries = errors.deepErrors();
    } catch {
      entries = [];
    }
  } else if (Array.isArray(errors)) {
    entries = errors;
  }

  return entries.map((error) => redact({
    attribute: error?.attribute ?? null,
    code: error?.code == null ? null : String(error.code),
    message: summarizeDiagnosticText(error?.message) ?? 'Braintree validation failed',
  }));
}

function summarizeGatewayResult(result) {
  return {
    success: result?.success === true,
    message: summarizeDiagnosticText(result?.message),
    transaction: summarizeTransaction(result?.transaction),
    validationErrors: summarizeValidationErrors(result?.errors),
  };
}

function verifyMerchantAccount(result, expectedMerchantAccountId) {
  const actualMerchantAccountId = result?.transaction?.merchantAccountId ?? null;

  return {
    passed:
      typeof expectedMerchantAccountId === 'string' &&
      actualMerchantAccountId === expectedMerchantAccountId,
    expectedMerchantAccountId,
    actualMerchantAccountId,
    explanation:
      actualMerchantAccountId === expectedMerchantAccountId
        ? 'Braintree returned the merchant account selected by the routing engine.'
        : 'The merchant account returned by Braintree did not match the selected route.',
  };
}

function buildSandboxTransactionUrl(merchantId, transactionId) {
  if (
    typeof merchantId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(merchantId) ||
    typeof transactionId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(transactionId)
  ) {
    return null;
  }

  return `https://sandbox.braintreegateway.com/merchants/${encodeURIComponent(
    merchantId
  )}/transactions/${encodeURIComponent(transactionId)}`;
}

function buildSandboxSubscriptionUrl(merchantId, subscriptionId) {
  if (
    typeof merchantId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(merchantId) ||
    typeof subscriptionId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(subscriptionId)
  ) {
    return null;
  }

  return `https://sandbox.braintreegateway.com/merchants/${encodeURIComponent(
    merchantId
  )}/subscriptions/${encodeURIComponent(subscriptionId)}`;
}

module.exports = {
  buildSandboxSubscriptionUrl,
  buildSandboxTransactionUrl,
  summarizeCardVerification,
  summarizeGatewayResult,
  summarizeSubscription,
  summarizeTransaction,
  summarizeValidationErrors,
  summarizeVaultResult,
  verifyMerchantAccount,
  verifySubscriptionRoute,
  verifyVaultResult,
};
