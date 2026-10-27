'use strict';

const braintree = require('braintree');
const {
  CatalogUnavailableError,
  MerchantAccountNotFoundError,
} = require('../catalog/errors');
const { getRuntimeCatalogService } = require('../catalog/runtime');

const REQUIRED_CREDENTIALS = ['MERCHANT_ID', 'PUBLIC_KEY', 'PRIVATE_KEY'];

class MerchantAccountIdRequiredError extends TypeError {
  constructor(operation) {
    super(`${operation} requires an explicit merchantAccountId`);
    this.name = 'MerchantAccountIdRequiredError';
    this.code = 'MERCHANT_ACCOUNT_ID_REQUIRED';
  }
}

class UnknownMerchantAccountError extends MerchantAccountNotFoundError {
  constructor(merchantAccountId) {
    super(merchantAccountId);
    this.name = 'UnknownMerchantAccountError';
  }
}

class TransactionIdRequiredError extends TypeError {
  constructor(operation) {
    super(`${operation} requires a transactionId`);
    this.name = 'TransactionIdRequiredError';
    this.code = 'TRANSACTION_ID_REQUIRED';
  }
}

class TransactionMerchantAccountMismatchError extends Error {
  constructor({ transactionId, expectedMerchantAccountId, actualMerchantAccountId }) {
    super(
      `Transaction ${transactionId} belongs to merchant account ` +
      `${actualMerchantAccountId || '(missing)'}, not ${expectedMerchantAccountId}`
    );
    this.name = 'TransactionMerchantAccountMismatchError';
    this.code = 'TRANSACTION_MERCHANT_ACCOUNT_MISMATCH';
    this.transactionId = transactionId;
    this.expectedMerchantAccountId = expectedMerchantAccountId;
    this.actualMerchantAccountId = actualMerchantAccountId ?? null;
  }
}

function requireMerchantAccountId(merchantAccountId, operation) {
  if (typeof merchantAccountId !== 'string' || merchantAccountId.trim() === '') {
    throw new MerchantAccountIdRequiredError(operation);
  }

  return merchantAccountId.trim();
}

function requireTransactionId(transactionId, operation) {
  if (typeof transactionId !== 'string' || transactionId.trim() === '') {
    throw new TransactionIdRequiredError(operation);
  }

  return transactionId.trim();
}

function optionalTrimmedAmount(amount) {
  if (amount === undefined || amount === null) return undefined;
  if (typeof amount !== 'string' && typeof amount !== 'number') {
    throw new TypeError('amount must be a string or finite number');
  }

  const resolved = typeof amount === 'string' ? amount.trim() : String(amount);
  if (resolved === '' || (typeof amount === 'number' && !Number.isFinite(amount))) {
    throw new TypeError('amount must be a non-empty finite value');
  }

  return resolved;
}

function getConfiguredMerchantId(environment = process.env) {
  if (
    typeof environment.MERCHANT_ID !== 'string' ||
    environment.MERCHANT_ID.trim() === ''
  ) {
    throw new Error('Missing Braintree Sandbox configuration: MERCHANT_ID');
  }

  return environment.MERCHANT_ID.trim();
}

function assertSandboxConfiguration(environment) {
  const configured = environment.BRAINTREE_ENVIRONMENT ?? environment.environment;
  if (configured == null || configured === '') return;

  const normalized = String(configured).trim().toLowerCase();
  if (!['sandbox', 'braintree.environment.sandbox'].includes(normalized)) {
    throw new Error('This demo only supports the Braintree Sandbox environment');
  }
}

function createGateway(environment = process.env) {
  assertSandboxConfiguration(environment);
  const missing = REQUIRED_CREDENTIALS.filter(
    (name) => typeof environment[name] !== 'string' || environment[name].trim() === ''
  );

  if (missing.length > 0) {
    throw new Error(`Missing Braintree Sandbox configuration: ${missing.join(', ')}`);
  }

  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: environment.MERCHANT_ID.trim(),
    publicKey: environment.PUBLIC_KEY.trim(),
    privateKey: environment.PRIVATE_KEY.trim(),
  });
}

function createGatewayClient(
  gateway,
  { catalogService, getCatalogService = getRuntimeCatalogService } = {}
) {
  if (!gateway?.clientToken?.generate || !gateway?.transaction?.sale) {
    throw new TypeError('A Braintree gateway with clientToken and transaction APIs is required');
  }

  if (catalogService && typeof catalogService.assertMerchantAccountId !== 'function') {
    throw new TypeError('The catalog service must validate merchant account IDs');
  }
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A merchant account catalog service is required');
  }

  function validateMerchantAccountId(merchantAccountId) {
    const service = catalogService || getCatalogService();
    if (!service || typeof service.assertMerchantAccountId !== 'function') {
      throw new CatalogUnavailableError(
        'Merchant account discovery has not been configured.'
      );
    }

    try {
      return service.assertMerchantAccountId(merchantAccountId);
    } catch (error) {
      if (error instanceof MerchantAccountNotFoundError) {
        throw new UnknownMerchantAccountError(merchantAccountId);
      }
      throw error;
    }
  }

  function requireOperation(operation, candidate) {
    if (typeof candidate !== 'function') {
      throw new TypeError(`The Braintree gateway does not support ${operation}`);
    }

    return candidate;
  }

  function assertReturnedMerchantAccount(
    transaction,
    { transactionId, merchantAccountId, requireTransaction = false }
  ) {
    if (!transaction && !requireTransaction) return;

    const actualMerchantAccountId = transaction?.merchantAccountId ?? null;
    if (actualMerchantAccountId !== merchantAccountId) {
      throw new TransactionMerchantAccountMismatchError({
        transactionId,
        expectedMerchantAccountId: merchantAccountId,
        actualMerchantAccountId,
      });
    }
  }

  function normalizeSettlementResponse(response) {
    const isObject = response && typeof response === 'object';
    const nestedTransaction = isObject && response.transaction &&
      typeof response.transaction === 'object'
      ? response.transaction
      : null;
    const directTransaction = !nestedTransaction && isObject &&
      typeof response.id === 'string' && response.id.trim() !== ''
      ? response
      : null;
    const transaction = nestedTransaction || directTransaction;
    const explicitSuccess = isObject && typeof response.success === 'boolean'
      ? response.success
      : null;
    const success = explicitSuccess ?? Boolean(transaction?.id);

    return {
      ...(nestedTransaction ? response : {}),
      success,
      transaction,
      message: typeof response?.message === 'string' && response.message.trim() !== ''
        ? response.message
        : success
          ? null
          : 'Braintree did not return a settled transaction.',
    };
  }

  async function generateClientToken({ merchantAccountId } = {}) {
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Client-token generation'
    );
    validateMerchantAccountId(resolvedMerchantAccountId);
    const response = await gateway.clientToken.generate({
      merchantAccountId: resolvedMerchantAccountId,
    });

    if (typeof response?.clientToken !== 'string' || response.clientToken === '') {
      throw new Error('Braintree did not return a client token');
    }

    return response.clientToken;
  }

  async function createSale({
    merchantAccountId,
    amount,
    paymentMethodNonce,
    paymentMethodToken,
    customerId,
    orderId,
    submitForSettlement = true,
  } = {}) {
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Transaction sale'
    );
    validateMerchantAccountId(resolvedMerchantAccountId);
    const paymentSources = [paymentMethodNonce, paymentMethodToken, customerId].filter(
      (value) => typeof value === 'string' && value.trim() !== ''
    );

    if (paymentSources.length !== 1) {
      throw new TypeError(
        'Transaction sale requires exactly one paymentMethodNonce, paymentMethodToken, or customerId'
      );
    }

    const request = {
      amount,
      merchantAccountId: resolvedMerchantAccountId,
      options: {
        submitForSettlement: Boolean(submitForSettlement),
      },
    };

    if (typeof paymentMethodNonce === 'string' && paymentMethodNonce.trim() !== '') {
      request.paymentMethodNonce = paymentMethodNonce;
    }
    if (typeof paymentMethodToken === 'string' && paymentMethodToken.trim() !== '') {
      request.paymentMethodToken = paymentMethodToken;
    }
    if (typeof customerId === 'string' && customerId.trim() !== '') {
      request.customerId = customerId;
    }
    if (typeof orderId === 'string' && orderId.trim() !== '') {
      request.orderId = orderId.trim();
    }

    return gateway.transaction.sale(request);
  }

  async function findTransaction({ transactionId, merchantAccountId } = {}) {
    const resolvedTransactionId = requireTransactionId(
      transactionId,
      'Transaction lookup'
    );
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Transaction lookup'
    );
    const find = requireOperation('transaction lookup', gateway?.transaction?.find);

    // Keep this check adjacent to the SDK call. A catalog refresh can invalidate
    // an account without requiring this gateway client to be recreated.
    validateMerchantAccountId(resolvedMerchantAccountId);
    const transaction = await find.call(gateway.transaction, resolvedTransactionId);
    assertReturnedMerchantAccount(transaction, {
      transactionId: resolvedTransactionId,
      merchantAccountId: resolvedMerchantAccountId,
      requireTransaction: true,
    });

    return transaction;
  }

  async function captureTransaction({ transactionId, merchantAccountId, amount } = {}) {
    const resolvedTransactionId = requireTransactionId(
      transactionId,
      'Transaction capture'
    );
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Transaction capture'
    );
    const resolvedAmount = optionalTrimmedAmount(amount);
    const submitForSettlement = requireOperation(
      'transaction capture',
      gateway?.transaction?.submitForSettlement
    );

    validateMerchantAccountId(resolvedMerchantAccountId);
    const result = resolvedAmount === undefined
      ? await submitForSettlement.call(gateway.transaction, resolvedTransactionId)
      : await submitForSettlement.call(
          gateway.transaction,
          resolvedTransactionId,
          resolvedAmount
        );
    assertReturnedMerchantAccount(result?.transaction, {
      transactionId: resolvedTransactionId,
      merchantAccountId: resolvedMerchantAccountId,
    });

    return result;
  }

  async function voidTransaction({ transactionId, merchantAccountId } = {}) {
    const resolvedTransactionId = requireTransactionId(
      transactionId,
      'Transaction void'
    );
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Transaction void'
    );
    const voidOperation = requireOperation('transaction void', gateway?.transaction?.void);

    validateMerchantAccountId(resolvedMerchantAccountId);
    const result = await voidOperation.call(gateway.transaction, resolvedTransactionId);
    assertReturnedMerchantAccount(result?.transaction, {
      transactionId: resolvedTransactionId,
      merchantAccountId: resolvedMerchantAccountId,
    });

    return result;
  }

  async function settleTransaction({ transactionId, merchantAccountId } = {}) {
    const resolvedTransactionId = requireTransactionId(
      transactionId,
      'Sandbox transaction settlement'
    );
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Sandbox transaction settlement'
    );
    const settle = requireOperation(
      'sandbox transaction settlement',
      gateway?.testing?.settle
    );

    validateMerchantAccountId(resolvedMerchantAccountId);
    const response = await settle.call(gateway.testing, resolvedTransactionId);
    // The Node SDK's Sandbox testing helper returns the Transaction directly,
    // while other versions or adapters can return a Result-like wrapper.
    // Normalize every observed shape so callers always receive an explicit
    // success flag and transaction field.
    const result = normalizeSettlementResponse(response);
    assertReturnedMerchantAccount(result.transaction, {
      transactionId: resolvedTransactionId,
      merchantAccountId: resolvedMerchantAccountId,
      requireTransaction: result.success === true,
    });

    return result;
  }

  async function refundTransaction({ transactionId, merchantAccountId, amount } = {}) {
    const resolvedTransactionId = requireTransactionId(
      transactionId,
      'Transaction refund'
    );
    const resolvedMerchantAccountId = requireMerchantAccountId(
      merchantAccountId,
      'Transaction refund'
    );
    const resolvedAmount = optionalTrimmedAmount(amount);
    const refund = requireOperation('transaction refund', gateway?.transaction?.refund);
    const options = {
      merchantAccountId: resolvedMerchantAccountId,
    };
    if (resolvedAmount !== undefined) options.amount = resolvedAmount;

    // Passing merchantAccountId is deliberate even for a full refund: omission
    // permits Braintree to use the gateway default account.
    validateMerchantAccountId(resolvedMerchantAccountId);
    const result = await refund.call(
      gateway.transaction,
      resolvedTransactionId,
      options
    );
    assertReturnedMerchantAccount(result?.transaction, {
      transactionId: resolvedTransactionId,
      merchantAccountId: resolvedMerchantAccountId,
    });

    return result;
  }

  return Object.freeze({
    generateClientToken,
    createSale,
    findTransaction,
    captureTransaction,
    voidTransaction,
    settleTransaction,
    refundTransaction,
  });
}

let defaultGateway;
let defaultGatewayClient;

function getGateway() {
  if (!defaultGateway) defaultGateway = createGateway();
  return defaultGateway;
}

function getGatewayClient() {
  if (!defaultGatewayClient) {
    // The default client resolves the runtime service for every operation, so a
    // refresh immediately invalidates stale account IDs without recreating it.
    defaultGatewayClient = createGatewayClient(getGateway(), {
      getCatalogService: getRuntimeCatalogService,
    });
  }

  return defaultGatewayClient;
}

function resetGatewayClientForTests() {
  defaultGatewayClient = undefined;
}

function resetGatewayForTests() {
  defaultGateway = undefined;
  defaultGatewayClient = undefined;
}

module.exports = {
  assertSandboxConfiguration,
  CatalogUnavailableError,
  MerchantAccountIdRequiredError,
  TransactionIdRequiredError,
  TransactionMerchantAccountMismatchError,
  UnknownMerchantAccountError,
  createGateway,
  createGatewayClient,
  getConfiguredMerchantId,
  getGateway,
  getGatewayClient,
  requireMerchantAccountId,
  requireTransactionId,
  resetGatewayForTests,
  resetGatewayClientForTests,
};
