'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  paymentMethodFromInstrumentType,
  paymentMethodFromNonce,
} = require('../lib/payment-methods');

test('payment method nonce classification uses corroborating SDK type and safe details', () => {
  assert.equal(
    paymentMethodFromNonce({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '1111' },
    }),
    'card'
  );
  assert.equal(
    paymentMethodFromNonce({
      type: 'PayPalAccount',
      details: { payerInfo: {} },
    }),
    'paypal'
  );
  assert.equal(
    paymentMethodFromNonce({ details: { cardType: 'MasterCard' } }),
    'card'
  );
  assert.equal(
    paymentMethodFromNonce({ details: { payerInfo: {} } }),
    'paypal'
  );
});

test('payment method nonce classification rejects missing, unknown, or conflicting evidence', () => {
  assert.equal(paymentMethodFromNonce(null), null);
  assert.equal(paymentMethodFromNonce({ details: {} }), null);
  assert.equal(paymentMethodFromNonce({ type: 'VenmoAccount' }), null);
  assert.equal(
    paymentMethodFromNonce({
      type: 'VenmoAccount',
      details: { cardType: 'Visa' },
    }),
    null
  );
  assert.equal(
    paymentMethodFromNonce({
      type: 'CreditCard',
      details: { payerInfo: {} },
    }),
    null
  );
});

test('transaction instrument types map only to enabled canonical methods', () => {
  assert.equal(paymentMethodFromInstrumentType('credit_card'), 'card');
  assert.equal(paymentMethodFromInstrumentType(' PayPal_Account '), 'paypal');
  assert.equal(paymentMethodFromInstrumentType('venmo_account'), null);
  assert.equal(paymentMethodFromInstrumentType(undefined), null);
});
