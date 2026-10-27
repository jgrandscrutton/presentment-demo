'use strict';

const { redact } = require('../inspector/redact');

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

function serializeValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function summarizeTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return null;
  }

  return redact(Object.fromEntries(
    SAFE_TRANSACTION_FIELDS
      .filter((field) => transaction[field] !== undefined && transaction[field] !== null)
      .map((field) => [field, serializeValue(transaction[field])])
  ));
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
    message: error?.message ?? 'Braintree validation failed',
  }));
}

function summarizeGatewayResult(result) {
  return {
    success: result?.success === true,
    message: typeof result?.message === 'string' ? redact(result.message) : null,
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

module.exports = {
  buildSandboxTransactionUrl,
  summarizeGatewayResult,
  summarizeTransaction,
  summarizeValidationErrors,
  verifyMerchantAccount,
};
