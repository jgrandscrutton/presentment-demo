'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CIRCULAR,
  REDACTED,
  TRUNCATED,
  redact,
} = require('../lib/inspector/redact');

test('redact removes gateway, payment, card, and personal secrets without mutation', () => {
  const source = {
    merchantAccountId: 'vmUSD',
    credentials: {
      merchantId: 'merchant-secret',
      publicKey: 'public-secret',
      privateKey: 'private-secret',
    },
    request: {
      clientToken: 'client-secret',
      paymentMethodNonce: 'fake-valid-nonce',
      creditCard: {
        number: '4111111111111111',
        cvv: '123',
        expirationDate: '12/30',
      },
    },
    response: {
      id: 'txn-safe-id',
      status: 'submitted_for_settlement',
      merchantAccountId: 'vmUSD',
      currencyIsoCode: 'USD',
      amount: '12.00',
      creditCard: {
        cardType: 'Visa',
        last4: '1111',
        maskedNumber: '************1111',
        token: 'vault-secret',
      },
      paypalAccount: {
        email: 'buyer@example.com',
      },
    },
  };

  const result = redact(source);

  assert.equal(result.credentials, REDACTED);
  assert.equal(result.request.clientToken, REDACTED);
  assert.equal(result.request.paymentMethodNonce, REDACTED);
  assert.equal(result.request.creditCard.number, REDACTED);
  assert.equal(result.request.creditCard.cvv, REDACTED);
  assert.equal(result.request.creditCard.expirationDate, REDACTED);
  assert.equal(result.response.creditCard.token, REDACTED);
  assert.equal(result.response.paypalAccount.email, REDACTED);

  assert.deepEqual(result.response, {
    id: 'txn-safe-id',
    status: 'submitted_for_settlement',
    merchantAccountId: 'vmUSD',
    currencyIsoCode: 'USD',
    amount: '12.00',
    creditCard: {
      cardType: 'Visa',
      last4: '1111',
      maskedNumber: '************1111',
      token: REDACTED,
    },
    paypalAccount: {
      email: REDACTED,
    },
  });

  assert.equal(source.credentials.privateKey, 'private-secret');
  assert.equal(source.request.paymentMethodNonce, 'fake-valid-nonce');
  assert.equal(source.response.creditCard.token, 'vault-secret');
  assert.notStrictEqual(result, source);
  assert.notStrictEqual(result.response, source.response);
});

test('redact catches sensitive values in diagnostics and safely handles cycles', () => {
  const source = {
    headers: { authorization: 'Bearer token-value' },
    webhook: { bt_signature: 'signature-secret', bt_payload: 'payload-secret' },
    diagnostics: [
      '4111 1111 1111 1111',
      'buyer@example.com',
      'payment nonce=fake-valid-nonce',
      'processor echoed card 4111-1111-1111-1111 in its message',
      'PayPal payer was buyer@example.com before checkout',
      'privateKey=private-secret password=hunter2 api_key=api-secret',
      'ordinary message',
    ],
  };
  source.self = source;

  const result = redact(source);

  assert.equal(result.headers.authorization, REDACTED);
  assert.equal(result.webhook.bt_signature, REDACTED);
  assert.equal(result.webhook.bt_payload, REDACTED);
  assert.equal(result.diagnostics[0], REDACTED);
  assert.equal(result.diagnostics[1], REDACTED);
  assert.equal(result.diagnostics[2], `payment nonce=${REDACTED}`);
  assert.equal(result.diagnostics[3], `processor echoed card ${REDACTED} in its message`);
  assert.equal(result.diagnostics[4], `PayPal payer was ${REDACTED} before checkout`);
  assert.equal(
    result.diagnostics[5],
    `privateKey=${REDACTED} password=${REDACTED} api_key=${REDACTED}`
  );
  assert.equal(result.diagnostics[6], 'ordinary message');
  assert.equal(result.self, CIRCULAR);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('redact flattens SDK-style instances and never evaluates accessors', () => {
  let accessorRead = false;

  class FakeTransaction {
    constructor() {
      this.id = 'txn-123';
      this.status = 'authorized';
      this.paymentMethodToken = 'vault-token';
      Object.defineProperty(this, 'dangerousAccessor', {
        enumerable: true,
        get() {
          accessorRead = true;
          return 'secret';
        },
      });
    }

    submitForSettlement() {}
  }

  const result = redact(new FakeTransaction());

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(result, {
    id: 'txn-123',
    status: 'authorized',
    paymentMethodToken: REDACTED,
    dangerousAccessor: '[Unsupported value]',
  });
  assert.equal(accessorRead, false);
  assert.equal('submitForSettlement' in result, false);
});

test('redact supports explicit depth limits and leaves safe summaries intact', () => {
  const summary = {
    id: 'txn-safe',
    status: 'processor_declined',
    merchantAccountId: 'paypal2',
    currency: 'GBP',
    amount: '10.00',
    processorResponseCode: '2000',
    processorResponseText: 'Do Not Honor',
    paymentInstrumentType: 'credit_card',
    cardType: 'MasterCard',
    last4: '4444',
  };

  assert.deepEqual(redact(summary), summary);
  assert.deepEqual(redact({ one: { two: true } }, { maxDepth: 1 }), {
    one: { two: TRUNCATED },
  });
});
