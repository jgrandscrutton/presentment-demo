'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CatalogUnavailableError,
  MerchantAccountIdRequiredError,
  TransactionIdRequiredError,
  TransactionMerchantAccountMismatchError,
  UnknownMerchantAccountError,
  createGatewayClient,
} = require('../lib/braintree/gateway');
const { MerchantAccountNotFoundError } = require('../lib/catalog/errors');
const {
  summarizeGatewayResult,
  summarizeTransaction,
  verifyMerchantAccount,
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
} = {}) {
  const calls = {
    clientToken: [],
    sale: [],
    find: [],
    capture: [],
    void: [],
    settle: [],
    refund: [],
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
