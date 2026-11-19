'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSandboxSubscriptionUrl,
  summarizeCardVerification,
  summarizeSubscription,
  summarizeVaultResult,
  verifySubscriptionRoute,
  verifyVaultResult,
} = require('../lib/braintree/result');

const expectedAccount = Object.freeze({
  merchantAccountId: 'vmUSD2',
  currency: 'USD',
});

test('subscription Control Panel links accept only conservative Sandbox identifiers', () => {
  assert.equal(
    buildSandboxSubscriptionUrl('sandbox-merchant', 'subscription_123'),
    'https://sandbox.braintreegateway.com/merchants/sandbox-merchant/subscriptions/subscription_123'
  );
  assert.equal(buildSandboxSubscriptionUrl('../merchant', 'subscription_123'), null);
  assert.equal(buildSandboxSubscriptionUrl('sandbox-merchant', 'https://evil.test'), null);
});

function verifiedCard(overrides = {}) {
  return {
    token: 'vault-token-server-secret',
    paymentMethodNonce: 'fake-valid-nonce',
    cardType: 'Visa',
    last4: '1111',
    maskedNumber: '411111******1111',
    default: true,
    verification: {
      id: 'verification-demo',
      status: 'verified',
      amount: '1.00',
      merchantAccountId: 'vmUSD2',
      currencyIsoCode: 'USD',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      createdAt: new Date('2026-10-27T09:00:00.000Z'),
    },
    ...overrides,
  };
}

test('vault summary exposes verification proof without payment or customer secrets', () => {
  const rawResult = {
    success: true,
    message: 'Created for buyer@example.com with nonce=fake-valid-nonce paymentMethodToken=vault-token-server-secret',
    customer: {
      id: 'demo-customer-1',
      email: 'buyer@example.com',
      createdAt: new Date('2026-10-27T08:59:00.000Z'),
      creditCards: [verifiedCard()],
    },
    paymentMethodToken: 'vault-token-server-secret',
  };

  assert.deepEqual(summarizeVaultResult(rawResult), {
    success: true,
    message: 'Created for [REDACTED] with nonce=[REDACTED] [REDACTED]',
    customer: {
      id: 'demo-customer-1',
      createdAt: '2026-10-27T08:59:00.000Z',
    },
    paymentMethod: {
      cardType: 'Visa',
      last4: '1111',
      maskedNumber: '411111******1111',
      default: true,
    },
    verification: {
      id: 'verification-demo',
      status: 'verified',
      amount: '1.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'vmUSD2',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      createdAt: '2026-10-27T09:00:00.000Z',
    },
    validationErrors: [],
  });

  const serialized = JSON.stringify(summarizeVaultResult(rawResult));
  for (const secret of [
    'vault-token-server-secret',
    'fake-valid-nonce',
    'buyer@example.com',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('paymentMethodToken'), false);
  assert.equal(serialized.includes('paymentMethodNonce'), false);
  assert.equal(serialized.includes('email'), false);
});

test('card verification summary uses a strict safe-field allowlist', () => {
  assert.deepEqual(summarizeCardVerification({
    status: 'verified',
    merchantAccountId: 'vmUSD2',
    currencyIsoCode: 'USD',
    paymentMethodToken: 'never-copy-this',
    customer: { email: 'buyer@example.com' },
    arbitrarySdkField: 'never-copy-this-either',
  }), {
    status: 'verified',
    currencyIsoCode: 'USD',
    merchantAccountId: 'vmUSD2',
  });
});

test('vault helpers support failed verification response objects', () => {
  const result = {
    success: false,
    creditCardVerification: {
      status: 'processor_declined',
      merchantAccountId: 'vmUSD2',
      currencyIsoCode: 'USD',
      processorResponseCode: '2000',
      paymentMethodToken: 'never-copy-this',
    },
  };

  assert.deepEqual(summarizeVaultResult(result).verification, {
    status: 'processor_declined',
    currencyIsoCode: 'USD',
    merchantAccountId: 'vmUSD2',
    processorResponseCode: '2000',
  });
  assert.equal(verifyVaultResult(result, expectedAccount).passed, false);
});

test('vault verification requires verified status, merchant account, and currency', () => {
  const result = {
    success: true,
    customer: { creditCards: [verifiedCard()] },
  };

  assert.deepEqual(verifyVaultResult(result, expectedAccount), {
    passed: true,
    operationSucceeded: true,
    statusVerified: true,
    merchantAccountMatched: true,
    currencyMatched: true,
    actualStatus: 'verified',
    expectedMerchantAccountId: 'vmUSD2',
    actualMerchantAccountId: 'vmUSD2',
    expectedCurrency: 'USD',
    actualCurrency: 'USD',
    explanation: 'Braintree vaulted and verified the card on the selected merchant account and currency.',
  });

  assert.equal(verifyVaultResult({
    success: false,
    customer: { creditCards: [verifiedCard()] },
  }, expectedAccount).passed, false);

  const mismatches = [
    ['status', verifiedCard({ verification: {
      ...verifiedCard().verification,
      status: 'processor_declined',
    } })],
    ['merchant account', verifiedCard({ verification: {
      ...verifiedCard().verification,
      merchantAccountId: 'vmUSD',
    } })],
    ['currency', verifiedCard({ verification: {
      ...verifiedCard().verification,
      currencyIsoCode: 'GBP',
    } })],
  ];

  for (const [label, card] of mismatches) {
    const verification = verifyVaultResult(
      { success: false, customer: { creditCards: [card] } },
      expectedAccount
    );
    assert.equal(verification.passed, false, label);
  }
});

test('PayPal vault proof is method-only, defers route proof, and omits buyer secrets', () => {
  const result = {
    success: true,
    customer: {
      id: 'demo-paypal-customer',
      paypalAccounts: [{
        token: 'paypal-vault-token-secret',
        email: 'buyer@example.test',
        payerId: 'payer-secret',
        billingAgreementId: 'agreement-secret',
        default: true,
        createdAt: new Date('2026-11-16T12:00:00.000Z'),
      }],
    },
  };

  assert.deepEqual(summarizeVaultResult(result), {
    success: true,
    message: null,
    customer: { id: 'demo-paypal-customer' },
    paymentMethod: {
      type: 'paypal',
      default: true,
      createdAt: '2026-11-16T12:00:00.000Z',
    },
    verification: null,
    validationErrors: [],
  });
  assert.deepEqual(verifyVaultResult(result, expectedAccount, 'paypal'), {
    passed: true,
    paymentMethod: 'paypal',
    methodVerified: true,
    routeVerified: false,
    operationSucceeded: true,
    methodMatched: true,
    tokenPresent: true,
    merchantAccountMatched: null,
    currencyMatched: null,
    expectedMerchantAccountId: 'vmUSD2',
    actualMerchantAccountId: null,
    expectedCurrency: 'USD',
    actualCurrency: null,
    routeEvidence: 'deferred_to_billing',
    explanation:
      'Braintree vaulted the PayPal account; merchant-account and currency proof is deferred to the first billing result.',
  });

  const serialized = JSON.stringify(summarizeVaultResult(result));
  for (const secret of [
    'paypal-vault-token-secret',
    'buyer@example.test',
    'payer-secret',
    'agreement-secret',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('PayPal vault proof fails closed without a successful PayPal token', () => {
  const wrongMethod = {
    success: true,
    customer: { creditCards: [verifiedCard()] },
  };
  const missingToken = {
    success: true,
    customer: { paypalAccounts: [{ default: true }] },
  };

  assert.equal(verifyVaultResult(wrongMethod, expectedAccount, 'paypal').passed, false);
  assert.equal(verifyVaultResult(missingToken, expectedAccount, 'paypal').passed, false);
  assert.equal(
    verifyVaultResult({
      success: false,
      customer: { paypalAccounts: [{ token: 'secret', default: true }] },
    }, expectedAccount, 'paypal').passed,
    false
  );
});

test('subscription summary accepts a Result wrapper and omits tokens, nonces, and emails', () => {
  const summary = summarizeSubscription({
    success: true,
    subscription: {
      id: 'subscription-demo',
      merchantAccountId: 'vmUSD2',
      status: 'Active',
      planId: 'plan-usd',
      price: '25.00',
      nextBillingDate: new Date('2026-11-27T00:00:00.000Z'),
      paymentMethodToken: 'vault-token-server-secret',
      email: 'buyer@example.com',
      transactions: [{
        id: 'txn-recurring-1',
        status: 'submitted_for_settlement',
        merchantAccountId: 'vmUSD2',
        currencyIsoCode: 'USD',
        amount: '25.00',
        paymentMethodToken: 'vault-token-server-secret',
        paymentMethodNonce: 'fake-valid-nonce',
        customer: { email: 'buyer@example.com' },
      }],
    },
  });

  assert.deepEqual(summary, {
    id: 'subscription-demo',
    merchantAccountId: 'vmUSD2',
    status: 'Active',
    planId: 'plan-usd',
    price: '25.00',
    nextBillingDate: '2026-11-27T00:00:00.000Z',
    transactions: [{
      id: 'txn-recurring-1',
      status: 'submitted_for_settlement',
      amount: '25.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'vmUSD2',
    }],
  });

  const serialized = JSON.stringify(summary);
  for (const secret of [
    'vault-token-server-secret',
    'fake-valid-nonce',
    'buyer@example.com',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('subscription verification checks its account and every returned transaction route', () => {
  const pending = {
    id: 'subscription-pending',
    merchantAccountId: 'vmUSD2',
    status: 'Pending',
    transactions: [],
  };
  const pendingVerification = verifySubscriptionRoute(pending, expectedAccount);
  assert.equal(pendingVerification.passed, true);
  assert.equal(pendingVerification.currencyEvidenceAvailable, false);
  assert.equal(pendingVerification.transactionCurrenciesMatched, true);

  const active = {
    id: 'subscription-active',
    merchantAccountId: 'vmUSD2',
    transactions: [{
      id: 'txn-recurring-1',
      merchantAccountId: 'vmUSD2',
      currencyIsoCode: 'USD',
    }],
  };
  assert.deepEqual(verifySubscriptionRoute({ subscription: active }, expectedAccount), {
    passed: true,
    merchantAccountMatched: true,
    transactionMerchantAccountsMatched: true,
    transactionCurrenciesMatched: true,
    currencyEvidenceAvailable: true,
    expectedMerchantAccountId: 'vmUSD2',
    actualMerchantAccountId: 'vmUSD2',
    expectedCurrency: 'USD',
    transactionMerchantAccountIds: ['vmUSD2'],
    transactionCurrencies: ['USD'],
    explanation: 'Braintree returned the selected merchant account and matching transaction currencies.',
  });

  for (const [label, transaction] of [
    ['account', {
      id: 'txn-wrong-account',
      merchantAccountId: 'vmUSD',
      currencyIsoCode: 'USD',
    }],
    ['currency', {
      id: 'txn-wrong-currency',
      merchantAccountId: 'vmUSD2',
      currencyIsoCode: 'GBP',
    }],
  ]) {
    const verification = verifySubscriptionRoute(
      { ...active, transactions: [transaction] },
      expectedAccount
    );
    assert.equal(verification.passed, false, label);
  }
});

test('absent recurring results summarize and verify safely', () => {
  assert.equal(summarizeSubscription({ success: false }), null);
  assert.deepEqual(summarizeVaultResult(null), {
    success: false,
    message: null,
    customer: null,
    paymentMethod: null,
    verification: null,
    validationErrors: [],
  });
  assert.equal(verifyVaultResult(null, expectedAccount).passed, false);
  assert.equal(verifySubscriptionRoute(null, expectedAccount).passed, false);
});
