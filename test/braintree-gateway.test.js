'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CatalogUnavailableError,
  DisputeMerchantAccountMismatchError,
  IdentifierRequiredError,
  InvalidTransactionSourceError,
  MerchantAccountIdRequiredError,
  SubscriptionMerchantAccountMismatchError,
  TransactionIdRequiredError,
  TransactionMerchantAccountMismatchError,
  UnknownMerchantAccountError,
  createGatewayClient,
} = require('../lib/braintree/gateway');
const { MerchantAccountNotFoundError } = require('../lib/catalog/errors');
const {
  summarizeCardVerification,
  summarizeGatewayResult,
  summarizeSubscription,
  summarizeTransaction,
  summarizeVaultResult,
  verifyMerchantAccount,
  verifySubscriptionRoute,
  verifyVaultResult,
} = require('../lib/braintree/result');

function createRecordingGateway({
  clientTokenResponse = { clientToken: 'generated-client-token' },
  saleResponse = { success: true },
  findResponse = { id: 'txn-demo', merchantAccountId: 'vmUSD' },
  captureResponse = {
    success: true,
    transaction: { id: 'txn-demo', merchantAccountId: 'vmUSD' },
  },
  voidResponse = {
    success: true,
    transaction: { id: 'txn-demo', merchantAccountId: 'vmUSD' },
  },
  settleResponse = { id: 'txn-demo', status: 'settled', merchantAccountId: 'vmUSD' },
  refundResponse = {
    success: true,
    transaction: { id: 'refund-demo', merchantAccountId: 'vmUSD' },
  },
  customerCreateResponse = {
    success: true,
    customer: {
      id: 'demo-customer',
      creditCards: [{
        token: 'vault-token-secret',
        default: true,
        last4: '1111',
        cardType: 'Visa',
        verification: {
          status: 'verified',
          merchantAccountId: 'vmUSD',
          currencyIsoCode: 'USD',
        },
      }],
    },
  },
  customerFindResponse = {
    id: 'demo-customer',
    creditCards: [],
  },
  paymentMethodNonceResponse = {
    type: 'CreditCard',
    details: { cardType: 'Visa', lastFour: '1111' },
  },
  subscriptionCreateResponse = {
    success: true,
    subscription: {
      id: 'subscription-demo',
      merchantAccountId: 'vmUSD',
      planId: 'plan-usd',
      transactions: [],
    },
  },
  subscriptionFindResponse = {
    id: 'subscription-demo',
    merchantAccountId: 'vmUSD',
    planId: 'plan-usd',
    transactions: [],
  },
  subscriptionCancelResponse = {
    success: true,
    subscription: {
      id: 'subscription-demo',
      merchantAccountId: 'vmUSD',
      planId: 'plan-usd',
      status: 'Canceled',
      transactions: [],
    },
  },
  webhookParseResponse = {
    kind: 'dispute_opened',
    timestamp: new Date('2026-11-02T10:00:00.000Z'),
    dispute: { id: 'dispute-demo' },
  },
  disputeFindResponse = {
    success: true,
    dispute: {
      id: 'dispute-demo',
      status: 'open',
      merchantAccountId: 'vmUSD',
      transactionDetails: { id: 'txn-demo' },
    },
  },
  disputeAcceptResponse = {
    success: true,
    dispute: {
      id: 'dispute-demo',
      status: 'accepted',
      merchantAccountId: 'vmUSD',
      transactionDetails: { id: 'txn-demo' },
    },
  },
  disputeEvidenceResponse = {
    success: true,
    evidence: { id: 'evidence-demo' },
  },
  disputeFinalizeResponse = { success: true },
} = {}) {
  const calls = {
    clientToken: [],
    sale: [],
    find: [],
    capture: [],
    void: [],
    settle: [],
    refund: [],
    customerCreate: [],
    customerFind: [],
    paymentMethodNonceFind: [],
    subscriptionCreate: [],
    subscriptionFind: [],
    subscriptionCancel: [],
    webhookParse: [],
    disputeFind: [],
    disputeAccept: [],
    disputeEvidence: [],
    disputeFinalize: [],
  };

  return {
    calls,
    gateway: {
      clientToken: {
        async generate(request) {
          calls.clientToken.push(structuredClone(request));
          return clientTokenResponse;
        },
      },
      transaction: {
        async sale(request) {
          calls.sale.push(structuredClone(request));
          return saleResponse;
        },
        async find(transactionId) {
          calls.find.push(transactionId);
          return findResponse;
        },
        async submitForSettlement(...args) {
          calls.capture.push(structuredClone(args));
          return captureResponse;
        },
        async void(transactionId) {
          calls.void.push(transactionId);
          return voidResponse;
        },
        async refund(transactionId, options) {
          calls.refund.push([transactionId, structuredClone(options)]);
          return refundResponse;
        },
      },
      testing: {
        async settle(transactionId) {
          calls.settle.push(transactionId);
          return settleResponse;
        },
      },
      customer: {
        async create(request) {
          calls.customerCreate.push(structuredClone(request));
          return customerCreateResponse;
        },
        async find(customerId) {
          calls.customerFind.push(customerId);
          return customerFindResponse;
        },
      },
      paymentMethodNonce: {
        async find(nonce) {
          calls.paymentMethodNonceFind.push(nonce);
          return paymentMethodNonceResponse;
        },
      },
      subscription: {
        async create(request) {
          calls.subscriptionCreate.push(structuredClone(request));
          return subscriptionCreateResponse;
        },
        async find(subscriptionId) {
          calls.subscriptionFind.push(subscriptionId);
          return subscriptionFindResponse;
        },
        async cancel(subscriptionId) {
          calls.subscriptionCancel.push(subscriptionId);
          return subscriptionCancelResponse;
        },
      },
      webhookNotification: {
        async parse(btSignature, btPayload) {
          calls.webhookParse.push([btSignature, btPayload]);
          return webhookParseResponse;
        },
      },
      dispute: {
        async find(disputeId) {
          calls.disputeFind.push(disputeId);
          return disputeFindResponse;
        },
        async accept(disputeId) {
          calls.disputeAccept.push(disputeId);
          return disputeAcceptResponse;
        },
        async addTextEvidence(disputeId, evidence) {
          calls.disputeEvidence.push([disputeId, structuredClone(evidence)]);
          return disputeEvidenceResponse;
        },
        async finalize(disputeId) {
          calls.disputeFinalize.push(disputeId);
          return disputeFinalizeResponse;
        },
      },
    },
  };
}

function createMutableCatalog(initialAccounts = [
  ['paypal', 'active'],
  ['paypal2', 'active'],
  ['vmUSD', 'active'],
  ['vmUSD2', 'active'],
]) {
  let accounts = new Map(initialAccounts);
  return {
    replace(nextAccounts) {
      accounts = new Map(nextAccounts);
    },
    assertMerchantAccountId(merchantAccountId) {
      if (accounts.get(merchantAccountId) !== 'active') {
        throw new MerchantAccountNotFoundError(merchantAccountId);
      }
      return merchantAccountId;
    },
  };
}

function createValidatedClient(gateway, catalogService = createMutableCatalog()) {
  return createGatewayClient(gateway, { catalogService });
}

test('client-token generation rejects a missing merchant account before calling Braintree', async () => {
  for (const merchantAccountId of [undefined, null, '', '   ']) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.generateClientToken({ merchantAccountId }),
      (error) =>
        error instanceof MerchantAccountIdRequiredError &&
        error.code === 'MERCHANT_ACCOUNT_ID_REQUIRED'
    );
    assert.deepEqual(recording.calls.clientToken, []);
  }
});

test('sale rejects a missing merchant account before calling Braintree', async () => {
  for (const merchantAccountId of [undefined, null, '', '   ']) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.createSale({
        merchantAccountId,
        amount: '25.00',
        paymentMethodNonce: 'fake-valid-nonce',
      }),
      (error) =>
        error instanceof MerchantAccountIdRequiredError &&
        error.code === 'MERCHANT_ACCOUNT_ID_REQUIRED'
    );
    assert.deepEqual(recording.calls.sale, []);
  }
});

test('client-token generation sends the exact explicit merchant account ID', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  const token = await client.generateClientToken({ merchantAccountId: 'paypal2' });

  assert.equal(token, 'generated-client-token');
  assert.deepEqual(recording.calls.clientToken, [{ merchantAccountId: 'paypal2' }]);
});

test('sale sends the exact explicit merchant account ID and transaction options', async () => {
  const gatewayResult = {
    success: true,
    transaction: { id: 'txn-demo-1', merchantAccountId: 'vmUSD' },
  };
  const recording = createRecordingGateway({ saleResponse: gatewayResult });
  const client = createValidatedClient(recording.gateway);

  const result = await client.createSale({
    merchantAccountId: 'vmUSD',
    amount: '25.00',
    paymentMethodNonce: 'fake-valid-nonce',
    orderId: 'routing-demo-usd',
    submitForSettlement: true,
  });

  assert.strictEqual(result, gatewayResult);
  assert.deepEqual(recording.calls.sale, [
    {
      amount: '25.00',
      merchantAccountId: 'vmUSD',
      options: { submitForSettlement: true },
      paymentMethodNonce: 'fake-valid-nonce',
      orderId: 'routing-demo-usd',
    },
  ]);
});

test('sale maps the server-owned 3D Secure requirement only to nonce transactions', async () => {
  for (const threeDSecureRequired of [true, false]) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await client.createSale({
      merchantAccountId: 'paypal',
      amount: '18.50',
      paymentMethodNonce: 'three-d-secure-nonce',
      threeDSecureRequired,
    });

    assert.deepEqual(recording.calls.sale, [{
      amount: '18.50',
      merchantAccountId: 'paypal',
      options: {
        submitForSettlement: true,
        threeDSecure: { required: threeDSecureRequired },
      },
      paymentMethodNonce: 'three-d-secure-nonce',
    }]);
  }
});

test('sale rejects invalid or non-nonce 3D Secure options before calling Braintree', async () => {
  for (const threeDSecureRequired of [null, 'true', 1]) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.createSale({
        merchantAccountId: 'vmUSD',
        amount: '25.00',
        paymentMethodNonce: 'fake-valid-nonce',
        threeDSecureRequired,
      }),
      /threeDSecureRequired must be a boolean/
    );
    assert.deepEqual(recording.calls.sale, []);
  }

  for (const source of [
    { paymentMethodToken: 'vault-token-123' },
    { customerId: 'customer-123' },
  ]) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.createSale({
        merchantAccountId: 'vmUSD',
        amount: '25.00',
        ...source,
        threeDSecureRequired: true,
      }),
      /threeDSecureRequired can only be used with paymentMethodNonce/
    );
    assert.deepEqual(recording.calls.sale, []);
  }
});

test('sale forwards only recurring transaction sources at the top level', async () => {
  for (const transactionSource of ['recurring_first', 'recurring']) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await client.createSale({
      merchantAccountId: 'vmUSD2',
      amount: '25.00',
      paymentMethodToken: 'vault-token-123',
      transactionSource,
    });

    assert.deepEqual(recording.calls.sale, [{
      amount: '25.00',
      merchantAccountId: 'vmUSD2',
      options: { submitForSettlement: true },
      paymentMethodToken: 'vault-token-123',
      transactionSource,
    }]);
    assert.equal(
      Object.hasOwn(recording.calls.sale[0].options, 'transactionSource'),
      false
    );
  }
});

test('sale rejects unsupported transaction sources before calling Braintree', async () => {
  for (const transactionSource of [null, '', 'recurring_first ', 'unscheduled', true]) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.createSale({
        merchantAccountId: 'vmUSD2',
        amount: '25.00',
        paymentMethodToken: 'vault-token-123',
        transactionSource,
      }),
      (error) =>
        error instanceof InvalidTransactionSourceError &&
        error.code === 'INVALID_TRANSACTION_SOURCE'
    );
    assert.deepEqual(recording.calls.sale, []);
  }
});

test('sale accepts each supported payment source independently', async () => {
  const cases = [
    ['paymentMethodNonce', 'fake-valid-nonce'],
    ['paymentMethodToken', 'vault-token-123'],
    ['customerId', 'customer-123'],
  ];

  for (const [field, value] of cases) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await client.createSale({
      merchantAccountId: 'paypal',
      amount: '18.50',
      [field]: value,
    });

    assert.equal(recording.calls.sale.length, 1);
    assert.equal(recording.calls.sale[0].merchantAccountId, 'paypal');
    assert.equal(recording.calls.sale[0][field], value);
    assert.deepEqual(
      Object.keys(recording.calls.sale[0]).filter((key) => cases.some(([name]) => name === key)),
      [field]
    );
  }
});

test('sale requires exactly one payment source and never calls Braintree on failure', async () => {
  const invalidSources = [
    {},
    { paymentMethodNonce: '   ' },
    {
      paymentMethodNonce: 'fake-valid-nonce',
      paymentMethodToken: 'vault-token-123',
    },
    {
      paymentMethodNonce: 'fake-valid-nonce',
      customerId: 'customer-123',
    },
    {
      paymentMethodToken: 'vault-token-123',
      customerId: 'customer-123',
    },
  ];

  for (const sources of invalidSources) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.createSale({
        merchantAccountId: 'vmUSD',
        amount: '25.00',
        ...sources,
      }),
      /requires exactly one paymentMethodNonce, paymentMethodToken, or customerId/
    );
    assert.deepEqual(recording.calls.sale, []);
  }
});

test('unknown and inactive IDs are blocked before client-token or sale gateway calls', async () => {
  for (const [merchantAccountId, status] of [
    ['unknown-account', undefined],
    ['inactive-account', 'suspended'],
  ]) {
    const recording = createRecordingGateway();
    const catalog = createMutableCatalog([
      ['active-account', 'active'],
      ...(status ? [[merchantAccountId, status]] : []),
    ]);
    const client = createValidatedClient(recording.gateway, catalog);

    await assert.rejects(
      client.generateClientToken({ merchantAccountId }),
      (error) =>
        error instanceof UnknownMerchantAccountError &&
        error.code === 'UNKNOWN_MERCHANT_ACCOUNT'
    );
    await assert.rejects(
      client.createSale({
        merchantAccountId,
        amount: '1.00',
        paymentMethodNonce: 'fake-valid-nonce',
      }),
      (error) =>
        error instanceof UnknownMerchantAccountError &&
        error.code === 'UNKNOWN_MERCHANT_ACCOUNT'
    );

    assert.deepEqual(recording.calls.clientToken, []);
    assert.deepEqual(recording.calls.sale, []);
  }
});

test('an ID removed by refresh is stale and blocked before every gateway call', async () => {
  const recording = createRecordingGateway();
  const catalog = createMutableCatalog([['previous-account', 'active']]);
  const client = createValidatedClient(recording.gateway, catalog);

  catalog.replace([['replacement-account', 'active']]);

  await assert.rejects(
    client.generateClientToken({ merchantAccountId: 'previous-account' }),
    UnknownMerchantAccountError
  );
  await assert.rejects(
    client.createSale({
      merchantAccountId: 'previous-account',
      amount: '1.00',
      paymentMethodNonce: 'fake-valid-nonce',
    }),
    UnknownMerchantAccountError
  );
  assert.deepEqual(recording.calls.clientToken, []);
  assert.deepEqual(recording.calls.sale, []);
});

test('an unavailable catalog fails closed before every gateway call', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway, {
    assertMerchantAccountId() {
      throw new CatalogUnavailableError('Discovery failed safely.');
    },
  });

  await assert.rejects(
    client.generateClientToken({ merchantAccountId: 'candidate-account' }),
    CatalogUnavailableError
  );
  await assert.rejects(
    client.createSale({
      merchantAccountId: 'candidate-account',
      amount: '1.00',
      paymentMethodNonce: 'fake-valid-nonce',
    }),
    CatalogUnavailableError
  );
  assert.deepEqual(recording.calls.clientToken, []);
  assert.deepEqual(recording.calls.sale, []);
});

test('vault and customer wrappers send exact SDK request shapes', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  const created = await client.createVaultedCustomer({
    customerId: ' demo-customer ',
    paymentMethodNonce: ' fake-valid-nonce ',
    merchantAccountId: ' vmUSD ',
  });
  const found = await client.findCustomer({
    customerId: ' demo-customer ',
    merchantAccountId: ' vmUSD ',
  });

  assert.equal(created.success, true);
  assert.equal(found.id, 'demo-customer');
  assert.deepEqual(recording.calls.customerCreate, [{
    id: 'demo-customer',
    paymentMethodNonce: 'fake-valid-nonce',
    creditCard: {
      options: {
        verifyCard: true,
        verificationMerchantAccountId: 'vmUSD',
        makeDefault: true,
      },
    },
  }]);
  assert.deepEqual(recording.calls.customerFind, ['demo-customer']);
});

test('payment method nonce inspection trims the nonce and returns SDK metadata unchanged', async () => {
  const expected = {
    type: 'PayPalAccount',
    details: { payerInfo: { email: 'buyer@example.test' } },
  };
  const recording = createRecordingGateway({
    paymentMethodNonceResponse: expected,
  });
  const client = createValidatedClient(recording.gateway);

  const inspected = await client.inspectPaymentMethodNonce({
    paymentMethodNonce: ' paypal-nonce ',
  });

  assert.equal(inspected, expected);
  assert.deepEqual(recording.calls.paymentMethodNonceFind, ['paypal-nonce']);
});

test('payment method nonce inspection rejects missing values before the SDK call', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  await assert.rejects(
    client.inspectPaymentMethodNonce({ paymentMethodNonce: ' ' }),
    (error) =>
      error instanceof IdentifierRequiredError &&
      error.code === 'PAYMENT_METHOD_NONCE_REQUIRED'
  );
  assert.deepEqual(recording.calls.paymentMethodNonceFind, []);
});

test('PayPal vault creation omits card verification options', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  await client.createVaultedCustomer({
    customerId: 'demo-paypal-customer',
    paymentMethodNonce: 'paypal-nonce',
    merchantAccountId: 'vmUSD',
    paymentMethod: 'paypal',
  });

  assert.deepEqual(recording.calls.customerCreate, [{
    id: 'demo-paypal-customer',
    paymentMethodNonce: 'paypal-nonce',
  }]);
});

test('vault creation rejects unsupported method identifiers before the SDK call', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  await assert.rejects(
    client.createVaultedCustomer({
      customerId: 'demo-wallet-customer',
      paymentMethodNonce: 'wallet-nonce',
      merchantAccountId: 'vmUSD',
      paymentMethod: 'venmo',
    }),
    /supports card or paypal/
  );
  assert.deepEqual(recording.calls.customerCreate, []);
});

test('subscription wrappers send exact SDK request shapes', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  const created = await client.createSubscription({
    merchantAccountId: ' vmUSD ',
    paymentMethodToken: ' vault-token-123 ',
    planId: ' plan-usd ',
  });
  const found = await client.findSubscription({
    subscriptionId: ' subscription-demo ',
    merchantAccountId: ' vmUSD ',
  });
  const canceled = await client.cancelSubscription({
    subscriptionId: ' subscription-demo ',
    merchantAccountId: ' vmUSD ',
  });

  assert.equal(created.success, true);
  assert.equal(found.id, 'subscription-demo');
  assert.equal(canceled.success, true);
  assert.deepEqual(recording.calls.subscriptionCreate, [{
    merchantAccountId: 'vmUSD',
    paymentMethodToken: 'vault-token-123',
    planId: 'plan-usd',
  }]);
  assert.deepEqual(recording.calls.subscriptionFind, ['subscription-demo']);
  assert.deepEqual(recording.calls.subscriptionCancel, ['subscription-demo']);
});

test('vault and subscription wrappers require non-empty identifiers', async () => {
  const cases = [
    ['createVaultedCustomer', 'customerCreate', {
      customerId: ' ',
      paymentMethodNonce: 'fake-valid-nonce',
      merchantAccountId: 'vmUSD',
    }, 'customerId'],
    ['createVaultedCustomer', 'customerCreate', {
      customerId: 'demo-customer',
      paymentMethodNonce: null,
      merchantAccountId: 'vmUSD',
    }, 'paymentMethodNonce'],
    ['findCustomer', 'customerFind', {
      customerId: '',
      merchantAccountId: 'vmUSD',
    }, 'customerId'],
    ['createSubscription', 'subscriptionCreate', {
      merchantAccountId: 'vmUSD',
      paymentMethodToken: '',
      planId: 'plan-usd',
    }, 'paymentMethodToken'],
    ['createSubscription', 'subscriptionCreate', {
      merchantAccountId: 'vmUSD',
      paymentMethodToken: 'vault-token-123',
      planId: undefined,
    }, 'planId'],
    ['findSubscription', 'subscriptionFind', {
      subscriptionId: ' ',
      merchantAccountId: 'vmUSD',
    }, 'subscriptionId'],
    ['cancelSubscription', 'subscriptionCancel', {
      subscriptionId: null,
      merchantAccountId: 'vmUSD',
    }, 'subscriptionId'],
  ];

  for (const [method, callName, input, identifierName] of cases) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client[method](input),
      (error) =>
        error instanceof IdentifierRequiredError &&
        error.identifierName === identifierName
    );
    assert.deepEqual(recording.calls[callName], []);
  }
});

test('a stale account blocks every vault and subscription SDK call', async () => {
  const recording = createRecordingGateway();
  const catalog = createMutableCatalog([['stale-account', 'active']]);
  const client = createValidatedClient(recording.gateway, catalog);
  catalog.replace([['replacement-account', 'active']]);

  const operations = [
    ['createVaultedCustomer', {
      customerId: 'demo-customer',
      paymentMethodNonce: 'fake-valid-nonce',
      merchantAccountId: 'stale-account',
    }],
    ['findCustomer', {
      customerId: 'demo-customer',
      merchantAccountId: 'stale-account',
    }],
    ['createSubscription', {
      merchantAccountId: 'stale-account',
      paymentMethodToken: 'vault-token-123',
      planId: 'plan-usd',
    }],
    ['findSubscription', {
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'stale-account',
    }],
    ['cancelSubscription', {
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'stale-account',
    }],
  ];

  for (const [method, input] of operations) {
    await assert.rejects(client[method](input), UnknownMerchantAccountError);
  }

  for (const callName of [
    'customerCreate',
    'customerFind',
    'subscriptionCreate',
    'subscriptionFind',
    'subscriptionCancel',
  ]) {
    assert.deepEqual(recording.calls[callName], []);
  }
});

test('subscription wrappers reject returned subscription and transaction route mismatches', async () => {
  const wrongSubscription = createRecordingGateway({
    subscriptionFindResponse: {
      id: 'subscription-demo',
      merchantAccountId: 'vmUSD2',
      transactions: [],
    },
  });
  await assert.rejects(
    createValidatedClient(wrongSubscription.gateway).findSubscription({
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'vmUSD',
    }),
    (error) =>
      error instanceof SubscriptionMerchantAccountMismatchError &&
      error.code === 'SUBSCRIPTION_MERCHANT_ACCOUNT_MISMATCH' &&
      error.actualMerchantAccountId === 'vmUSD2'
  );

  const wrongTransaction = createRecordingGateway({
    subscriptionCreateResponse: {
      success: true,
      subscription: {
        id: 'subscription-demo',
        merchantAccountId: 'vmUSD',
        transactions: [{ id: 'txn-wrong-route', merchantAccountId: 'vmUSD2' }],
      },
    },
  });
  await assert.rejects(
    createValidatedClient(wrongTransaction.gateway).createSubscription({
      merchantAccountId: 'vmUSD',
      paymentMethodToken: 'vault-token-123',
      planId: 'plan-usd',
    }),
    (error) =>
      error instanceof TransactionMerchantAccountMismatchError &&
      error.transactionId === 'txn-wrong-route' &&
      error.actualMerchantAccountId === 'vmUSD2'
  );

  assert.deepEqual(wrongSubscription.calls.subscriptionFind, ['subscription-demo']);
  assert.equal(wrongTransaction.calls.subscriptionCreate.length, 1);
});

test('successful subscription mutations require a routed subscription response', async () => {
  const missingSubscription = createRecordingGateway({
    subscriptionCreateResponse: { success: true },
  });
  await assert.rejects(
    createValidatedClient(missingSubscription.gateway).createSubscription({
      merchantAccountId: 'vmUSD',
      paymentMethodToken: 'vault-token-123',
      planId: 'plan-usd',
    }),
    (error) =>
      error instanceof SubscriptionMerchantAccountMismatchError &&
      error.actualMerchantAccountId === null
  );

  const wrongCancellation = createRecordingGateway({
    subscriptionCancelResponse: {
      success: true,
      subscription: {
        id: 'subscription-demo',
        merchantAccountId: 'vmUSD2',
        transactions: [],
      },
    },
  });
  await assert.rejects(
    createValidatedClient(wrongCancellation.gateway).cancelSubscription({
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'vmUSD',
    }),
    SubscriptionMerchantAccountMismatchError
  );

  const failedResult = { success: false, message: 'Plan is invalid' };
  const expectedFailure = createRecordingGateway({
    subscriptionCreateResponse: failedResult,
  });
  const result = await createValidatedClient(
    expectedFailure.gateway
  ).createSubscription({
    merchantAccountId: 'vmUSD',
    paymentMethodToken: 'vault-token-123',
    planId: 'missing-plan',
  });
  assert.strictEqual(result, failedResult);
});

test('webhook parsing sends only the signed Braintree fields to the SDK parser', async () => {
  const notification = {
    kind: 'dispute_opened',
    timestamp: new Date('2026-11-02T10:00:00.000Z'),
    dispute: { id: 'dispute-demo' },
  };
  const recording = createRecordingGateway({ webhookParseResponse: notification });
  const client = createValidatedClient(recording.gateway);

  const parsed = await client.parseWebhookNotification({
    btSignature: ' public-key|signed-digest ',
    btPayload: ' signed-payload ',
  });

  assert.strictEqual(parsed, notification);
  assert.deepEqual(recording.calls.webhookParse, [[
    ' public-key|signed-digest ',
    ' signed-payload ',
  ]]);
});

test('webhook parsing rejects missing signature or payload before calling Braintree', async () => {
  for (const [identifierName, input] of [
    ['btSignature', { btSignature: ' ', btPayload: 'payload' }],
    ['btPayload', { btSignature: 'signature', btPayload: null }],
  ]) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.parseWebhookNotification(input),
      (error) =>
        error instanceof IdentifierRequiredError &&
        error.identifierName === identifierName
    );
    assert.deepEqual(recording.calls.webhookParse, []);
  }
});

test('dispute wrappers refetch the dispute, verify its route, and call exact SDK APIs', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  const found = await client.findDispute({
    disputeId: ' dispute-demo ',
    merchantAccountId: ' vmUSD ',
  });
  assert.equal(found.dispute.id, 'dispute-demo');

  const accepted = await client.acceptDispute({
    disputeId: ' dispute-demo ',
    merchantAccountId: ' vmUSD ',
  });
  assert.equal(accepted.dispute.status, 'accepted');

  const plainEvidence = await client.addDisputeTextEvidence({
    disputeId: ' dispute-demo ',
    merchantAccountId: ' vmUSD ',
    content: ' proof of delivery ',
  });
  assert.equal(plainEvidence.success, true);

  await client.addDisputeTextEvidence({
    disputeId: 'dispute-demo',
    merchantAccountId: 'vmUSD',
    content: ' tracking-123 ',
    category: ' TRACKING_NUMBER ',
    sequenceNumber: '2',
  });

  const finalized = await client.finalizeDispute({
    disputeId: ' dispute-demo ',
    merchantAccountId: ' vmUSD ',
  });
  assert.equal(finalized.success, true);

  assert.deepEqual(recording.calls.disputeFind, [
    'dispute-demo',
    'dispute-demo',
    'dispute-demo',
    'dispute-demo',
    'dispute-demo',
  ]);
  assert.deepEqual(recording.calls.disputeAccept, ['dispute-demo']);
  assert.deepEqual(recording.calls.disputeEvidence, [
    ['dispute-demo', 'proof of delivery'],
    ['dispute-demo', {
      content: 'tracking-123',
      category: 'TRACKING_NUMBER',
      sequenceNumber: '2',
    }],
  ]);
  assert.deepEqual(recording.calls.disputeFinalize, ['dispute-demo']);
});

test('dispute wrappers require identifiers and merchant accounts before SDK calls', async () => {
  const cases = [
    ['findDispute', { disputeId: ' ', merchantAccountId: 'vmUSD' }, IdentifierRequiredError],
    ['acceptDispute', { disputeId: 'dispute-demo', merchantAccountId: null }, MerchantAccountIdRequiredError],
    ['addDisputeTextEvidence', {
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
      content: '',
    }, IdentifierRequiredError],
    ['finalizeDispute', { disputeId: undefined, merchantAccountId: 'vmUSD' }, IdentifierRequiredError],
  ];

  for (const [method, input, ErrorClass] of cases) {
    const recording = createRecordingGateway();
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(client[method](input), ErrorClass);
    assert.deepEqual(recording.calls.disputeFind, []);
    assert.deepEqual(recording.calls.disputeAccept, []);
    assert.deepEqual(recording.calls.disputeEvidence, []);
    assert.deepEqual(recording.calls.disputeFinalize, []);
  }
});

test('stale accounts and mismatched dispute routes fail before dispute mutations', async () => {
  const stale = createRecordingGateway();
  const catalog = createMutableCatalog([['stale-account', 'active']]);
  const staleClient = createValidatedClient(stale.gateway, catalog);
  catalog.replace([['replacement-account', 'active']]);

  for (const [method, input] of [
    ['findDispute', { disputeId: 'dispute-demo', merchantAccountId: 'stale-account' }],
    ['acceptDispute', { disputeId: 'dispute-demo', merchantAccountId: 'stale-account' }],
    ['addDisputeTextEvidence', {
      disputeId: 'dispute-demo',
      merchantAccountId: 'stale-account',
      content: 'evidence',
    }],
    ['finalizeDispute', { disputeId: 'dispute-demo', merchantAccountId: 'stale-account' }],
  ]) {
    await assert.rejects(staleClient[method](input), UnknownMerchantAccountError);
  }
  assert.deepEqual(stale.calls.disputeFind, []);
  assert.deepEqual(stale.calls.disputeAccept, []);
  assert.deepEqual(stale.calls.disputeEvidence, []);
  assert.deepEqual(stale.calls.disputeFinalize, []);

  const mismatch = createRecordingGateway({
    disputeFindResponse: {
      success: true,
      dispute: {
        id: 'dispute-demo',
        status: 'open',
        merchantAccountId: 'vmUSD2',
      },
    },
  });
  await assert.rejects(
    createValidatedClient(mismatch.gateway).acceptDispute({
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
    }),
    (error) =>
      error instanceof DisputeMerchantAccountMismatchError &&
      error.code === 'DISPUTE_MERCHANT_ACCOUNT_MISMATCH' &&
      error.actualMerchantAccountId === 'vmUSD2'
  );
  assert.deepEqual(mismatch.calls.disputeFind, ['dispute-demo']);
  assert.deepEqual(mismatch.calls.disputeAccept, []);
});

test('successful dispute acceptance requires a response on the verified route', async () => {
  for (const [disputeAcceptResponse, actualMerchantAccountId] of [
    [{ success: true }, null],
    [{
      success: true,
      dispute: {
        id: 'dispute-demo',
        status: 'accepted',
        merchantAccountId: 'vmUSD2',
      },
    }, 'vmUSD2'],
  ]) {
    const recording = createRecordingGateway({ disputeAcceptResponse });
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.acceptDispute({
        disputeId: 'dispute-demo',
        merchantAccountId: 'vmUSD',
      }),
      (error) =>
        error instanceof DisputeMerchantAccountMismatchError &&
        error.actualMerchantAccountId === actualMerchantAccountId
    );
    assert.deepEqual(recording.calls.disputeFind, ['dispute-demo']);
    assert.deepEqual(recording.calls.disputeAccept, ['dispute-demo']);
  }
});

test('transaction operations require a transaction ID before calling Braintree', async () => {
  const operations = [
    ['findTransaction', 'find'],
    ['captureTransaction', 'capture'],
    ['voidTransaction', 'void'],
    ['settleTransaction', 'settle'],
    ['refundTransaction', 'refund'],
  ];

  for (const [method, callName] of operations) {
    for (const transactionId of [undefined, null, '', '   ']) {
      const recording = createRecordingGateway();
      const client = createValidatedClient(recording.gateway);

      await assert.rejects(
        client[method]({ transactionId, merchantAccountId: 'vmUSD' }),
        (error) =>
          error instanceof TransactionIdRequiredError &&
          error.code === 'TRANSACTION_ID_REQUIRED'
      );
      assert.deepEqual(recording.calls[callName], []);
    }
  }
});

test('transaction operations trim IDs and call the corresponding SDK APIs', async () => {
  const recording = createRecordingGateway();
  const client = createValidatedClient(recording.gateway);

  const found = await client.findTransaction({
    transactionId: '  txn-demo  ',
    merchantAccountId: ' vmUSD ',
  });
  assert.equal(found.id, 'txn-demo');

  await client.captureTransaction({
    transactionId: ' txn-demo ',
    merchantAccountId: ' vmUSD ',
  });
  await client.captureTransaction({
    transactionId: 'txn-demo',
    merchantAccountId: 'vmUSD',
    amount: ' 9.50 ',
  });
  await client.voidTransaction({
    transactionId: ' txn-demo ',
    merchantAccountId: 'vmUSD',
  });
  const settled = await client.settleTransaction({
    transactionId: ' txn-demo ',
    merchantAccountId: 'vmUSD',
  });
  assert.equal(settled.success, true);
  assert.equal(settled.transaction.status, 'settled');
  await client.refundTransaction({
    transactionId: ' txn-demo ',
    merchantAccountId: ' vmUSD ',
  });
  await client.refundTransaction({
    transactionId: 'txn-demo',
    merchantAccountId: 'vmUSD',
    amount: ' 4.25 ',
  });

  assert.deepEqual(recording.calls.find, ['txn-demo']);
  assert.deepEqual(recording.calls.capture, [
    ['txn-demo'],
    ['txn-demo', '9.50'],
  ]);
  assert.deepEqual(recording.calls.void, ['txn-demo']);
  assert.deepEqual(recording.calls.settle, ['txn-demo']);
  assert.deepEqual(recording.calls.refund, [
    ['txn-demo', { merchantAccountId: 'vmUSD' }],
    ['txn-demo', { merchantAccountId: 'vmUSD', amount: '4.25' }],
  ]);
});

test('sandbox settlement normalizes direct and Result-like SDK response shapes', async () => {
  const transaction = {
    id: 'txn-demo',
    status: 'settled',
    merchantAccountId: 'vmUSD',
  };
  const cases = [
    ['direct transaction', transaction],
    ['Result wrapper', { success: true, transaction, message: 'Settled' }],
    ['nested transaction without success', { transaction }],
  ];

  for (const [label, settleResponse] of cases) {
    const recording = createRecordingGateway({ settleResponse });
    const client = createValidatedClient(recording.gateway);
    const result = await client.settleTransaction({
      transactionId: 'txn-demo',
      merchantAccountId: 'vmUSD',
    });

    assert.equal(result.success, true, label);
    assert.strictEqual(result.transaction, transaction, label);
    assert.deepEqual(recording.calls.settle, ['txn-demo'], label);
  }
});

test('sandbox settlement preserves explicit failures without inventing a transaction', async () => {
  const recording = createRecordingGateway({
    settleResponse: { success: false, message: 'Settlement declined' },
  });
  const client = createValidatedClient(recording.gateway);

  const result = await client.settleTransaction({
    transactionId: 'txn-demo',
    merchantAccountId: 'vmUSD',
  });

  assert.equal(result.success, false);
  assert.equal(result.transaction, null);
  assert.equal(result.message, 'Settlement declined');
});

test('sandbox settlement rejects successful missing or mismatched transactions', async () => {
  for (const [settleResponse, actualMerchantAccountId] of [
    [{ success: true }, null],
    [{
      success: true,
      transaction: { id: 'txn-demo', merchantAccountId: 'vmUSD2' },
    }, 'vmUSD2'],
  ]) {
    const recording = createRecordingGateway({ settleResponse });
    const client = createValidatedClient(recording.gateway);

    await assert.rejects(
      client.settleTransaction({
        transactionId: 'txn-demo',
        merchantAccountId: 'vmUSD',
      }),
      (error) =>
        error instanceof TransactionMerchantAccountMismatchError &&
        error.actualMerchantAccountId === actualMerchantAccountId
    );
    assert.deepEqual(recording.calls.settle, ['txn-demo']);
  }
});

test('unknown or stale accounts are blocked before every transaction operation', async () => {
  const recording = createRecordingGateway();
  const catalog = createMutableCatalog([['stale-account', 'active']]);
  const client = createValidatedClient(recording.gateway, catalog);
  catalog.replace([['replacement-account', 'active']]);

  for (const method of [
    'findTransaction',
    'captureTransaction',
    'voidTransaction',
    'settleTransaction',
    'refundTransaction',
  ]) {
    await assert.rejects(
      client[method]({
        transactionId: 'txn-demo',
        merchantAccountId: 'stale-account',
      }),
      UnknownMerchantAccountError
    );
  }

  for (const callName of ['find', 'capture', 'void', 'settle', 'refund']) {
    assert.deepEqual(recording.calls[callName], []);
  }
});

test('transaction lookup fails closed when Braintree returns a different account', async () => {
  const recording = createRecordingGateway({
    findResponse: { id: 'txn-cross-account', merchantAccountId: 'vmUSD2' },
  });
  const client = createValidatedClient(recording.gateway);

  await assert.rejects(
    client.findTransaction({
      transactionId: 'txn-cross-account',
      merchantAccountId: 'vmUSD',
    }),
    (error) =>
      error instanceof TransactionMerchantAccountMismatchError &&
      error.code === 'TRANSACTION_MERCHANT_ACCOUNT_MISMATCH' &&
      error.actualMerchantAccountId === 'vmUSD2'
  );
  assert.deepEqual(recording.calls.find, ['txn-cross-account']);
});

test('new operation APIs are checked lazily so existing minimal fakes still work', async () => {
  const minimalGateway = {
    clientToken: { async generate() { return { clientToken: 'token' }; } },
    transaction: { async sale() { return { success: true }; } },
  };
  const client = createValidatedClient(minimalGateway);

  assert.equal(
    await client.generateClientToken({ merchantAccountId: 'vmUSD' }),
    'token'
  );
  await assert.rejects(
    client.captureTransaction({
      transactionId: 'txn-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support transaction capture/
  );
  await assert.rejects(
    client.createVaultedCustomer({
      customerId: 'demo-customer',
      paymentMethodNonce: 'fake-valid-nonce',
      merchantAccountId: 'vmUSD',
    }),
    /does not support customer creation/
  );
  await assert.rejects(
    client.findCustomer({
      customerId: 'demo-customer',
      merchantAccountId: 'vmUSD',
    }),
    /does not support customer lookup/
  );
  await assert.rejects(
    client.createSubscription({
      merchantAccountId: 'vmUSD',
      paymentMethodToken: 'vault-token-123',
      planId: 'plan-usd',
    }),
    /does not support subscription creation/
  );
  await assert.rejects(
    client.findSubscription({
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support subscription lookup/
  );
  await assert.rejects(
    client.cancelSubscription({
      subscriptionId: 'subscription-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support subscription cancellation/
  );
  await assert.rejects(
    client.parseWebhookNotification({
      btSignature: 'signature',
      btPayload: 'payload',
    }),
    /does not support webhook notification parsing/
  );
  await assert.rejects(
    client.findDispute({
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support dispute lookup/
  );
  await assert.rejects(
    client.acceptDispute({
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support dispute acceptance/
  );
  await assert.rejects(
    client.addDisputeTextEvidence({
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
      content: 'evidence',
    }),
    /does not support dispute text evidence/
  );
  await assert.rejects(
    client.finalizeDispute({
      disputeId: 'dispute-demo',
      merchantAccountId: 'vmUSD',
    }),
    /does not support dispute finalization/
  );
});

test('gateway result summary keeps routing proof and omits payment and credential secrets', () => {
  const createdAt = new Date('2026-10-14T09:30:00.000Z');
  const rawResult = {
    success: true,
    message: 'Approved',
    clientToken: 'client-token-secret',
    privateKey: 'private-key-secret',
    transaction: {
      id: 'txn-proof-1',
      status: 'submitted_for_settlement',
      amount: '25.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'vmUSD',
      paymentInstrumentType: 'credit_card',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      createdAt,
      paymentMethodNonce: 'nonce-secret',
      paymentMethodToken: 'vault-token-secret',
      publicKey: 'public-key-secret',
      privateKey: 'private-key-secret',
      creditCard: {
        number: '4111111111111111',
        cvv: '123',
      },
      customer: {
        paymentMethods: [{ token: 'nested-token-secret' }],
      },
    },
  };

  const summary = summarizeGatewayResult(rawResult);

  assert.deepEqual(summary, {
    success: true,
    message: 'Approved',
    transaction: {
      id: 'txn-proof-1',
      status: 'submitted_for_settlement',
      amount: '25.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'vmUSD',
      paymentInstrumentType: 'credit_card',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      createdAt: '2026-10-14T09:30:00.000Z',
    },
    validationErrors: [],
  });

  const serialized = JSON.stringify(summary);
  for (const secret of [
    'client-token-secret',
    'nonce-secret',
    'vault-token-secret',
    'public-key-secret',
    'private-key-secret',
    '4111111111111111',
    'nested-token-secret',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('paymentMethodNonce'), false);
  assert.equal(serialized.includes('paymentMethodToken'), false);
  assert.equal(serialized.includes('privateKey'), false);
});

test('transaction summary returns null for absent data and only includes allowlisted fields', () => {
  assert.equal(summarizeTransaction(null), null);
  assert.deepEqual(
    summarizeTransaction({
      id: 'txn-safe-1',
      merchantAccountId: 'paypal',
      arbitrarySdkField: 'do-not-copy',
    }),
    {
      id: 'txn-safe-1',
      merchantAccountId: 'paypal',
    }
  );
});

test('transaction summary includes safe refund relationship fields', () => {
  assert.deepEqual(
    summarizeTransaction({
      id: 'txn-original',
      refundIds: ['refund-1', 'refund-2'],
      refundedTransactionId: 'txn-parent',
      paymentMethodToken: 'do-not-copy',
    }),
    {
      id: 'txn-original',
      refundIds: ['refund-1', 'refund-2'],
      refundedTransactionId: 'txn-parent',
    }
  );
});

test('transaction summary exposes only safe 3D Secure evidence', () => {
  const summary = summarizeTransaction({
    id: 'txn-three-d-secure',
    threeDSecureInfo: {
      status: 'authenticate_successful',
      liabilityShiftPossible: true,
      liabilityShifted: true,
      cavv: 'secret-cavv',
      eciFlag: 'secret-eci',
      threeDSecureServerTransactionId: 'secret-server-transaction-id',
    },
  });

  assert.deepEqual(summary, {
    id: 'txn-three-d-secure',
    threeDSecureInfo: {
      status: 'authenticate_successful',
      liabilityShiftPossible: true,
      liabilityShifted: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret-/);
});

test('merchant-account verification reports a matching route', () => {
  const verification = verifyMerchantAccount(
    { transaction: { merchantAccountId: 'paypal2' } },
    'paypal2'
  );

  assert.deepEqual(verification, {
    passed: true,
    expectedMerchantAccountId: 'paypal2',
    actualMerchantAccountId: 'paypal2',
    explanation: 'Braintree returned the merchant account selected by the routing engine.',
  });
});

test('merchant-account verification reports mismatched and absent returned routes', () => {
  assert.deepEqual(
    verifyMerchantAccount(
      { transaction: { merchantAccountId: 'vmUSD2' } },
      'vmUSD'
    ),
    {
      passed: false,
      expectedMerchantAccountId: 'vmUSD',
      actualMerchantAccountId: 'vmUSD2',
      explanation: 'The merchant account returned by Braintree did not match the selected route.',
    }
  );

  assert.deepEqual(verifyMerchantAccount({}, 'vmUSD'), {
    passed: false,
    expectedMerchantAccountId: 'vmUSD',
    actualMerchantAccountId: null,
    explanation: 'The merchant account returned by Braintree did not match the selected route.',
  });
});
