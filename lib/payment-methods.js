'use strict';

const PAYMENT_METHOD_CARD = 'card';
const paymentMethodPayPal = 'paypal';
const PAYMENT_METHOD_PAYPAL = paymentMethodPayPal;

const PAYMENT_METHOD_ORDER = Object.freeze([
  PAYMENT_METHOD_CARD,
  PAYMENT_METHOD_PAYPAL,
  'venmo',
  'apple_pay',
  'google_pay',
  'local_payment',
]);

const PAYMENT_METHOD_LABELS = Object.freeze({
  [PAYMENT_METHOD_CARD]: 'Card',
  [paymentMethodPayPal]: 'PayPal',
  venmo: 'Venmo',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  local_payment: 'Local payment method',
});

const KNOWN_PAYMENT_METHODS = new Set(PAYMENT_METHOD_ORDER);
const IMPLEMENTED_PAYMENT_METHODS = new Set([
  PAYMENT_METHOD_CARD,
  PAYMENT_METHOD_PAYPAL,
]);
const DEFAULT_PAYMENT_METHODS = Object.freeze([PAYMENT_METHOD_CARD]);

const PAYMENT_METHOD_NONCE_TYPES = Object.freeze({
  [PAYMENT_METHOD_CARD]: 'CreditCard',
  [PAYMENT_METHOD_PAYPAL]: 'PayPalAccount',
});

const PAYMENT_INSTRUMENT_TYPES = Object.freeze({
  credit_card: PAYMENT_METHOD_CARD,
  paypal_account: PAYMENT_METHOD_PAYPAL,
});

function normalizePaymentMethod(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return KNOWN_PAYMENT_METHODS.has(normalized) ? normalized : null;
}

function sortPaymentMethods(methods) {
  const values = new Set(Array.isArray(methods) ? methods : []);
  return PAYMENT_METHOD_ORDER.filter((method) => values.has(method));
}

function paymentMethodFromNonceType(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();

  return Object.entries(PAYMENT_METHOD_NONCE_TYPES).find(
    ([, nonceType]) => nonceType.toLowerCase() === normalized
  )?.[0] || null;
}

function paymentMethodFromNonce(nonce) {
  if (!nonce || typeof nonce !== 'object') return null;

  const candidates = new Set();
  const directType = paymentMethodFromNonceType(nonce.type);
  const hasDirectType = Object.hasOwn(nonce, 'type') &&
    nonce.type !== undefined &&
    nonce.type !== null &&
    nonce.type !== '';
  if (hasDirectType && !directType) return null;
  if (directType) candidates.add(directType);

  const details = nonce.details;
  if (details && typeof details === 'object') {
    if (
      Object.hasOwn(details, 'payerInfo') &&
      details.payerInfo &&
      typeof details.payerInfo === 'object'
    ) {
      candidates.add(PAYMENT_METHOD_PAYPAL);
    }

    if (
      ['bin', 'cardType', 'expirationMonth', 'expirationYear', 'lastTwo', 'lastFour'].some(
        (field) =>
          Object.hasOwn(details, field) &&
          details[field] !== undefined &&
          details[field] !== null
      )
    ) {
      candidates.add(PAYMENT_METHOD_CARD);
    }
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}

function paymentMethodFromInstrumentType(value) {
  if (typeof value !== 'string') return null;
  return PAYMENT_INSTRUMENT_TYPES[value.trim().toLowerCase()] || null;
}

module.exports = {
  DEFAULT_PAYMENT_METHODS,
  IMPLEMENTED_PAYMENT_METHODS,
  KNOWN_PAYMENT_METHODS,
  PAYMENT_INSTRUMENT_TYPES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_NONCE_TYPES,
  PAYMENT_METHOD_ORDER,
  PAYMENT_METHOD_CARD,
  PAYMENT_METHOD_PAYPAL,
  normalizePaymentMethod,
  paymentMethodFromNonce,
  paymentMethodFromInstrumentType,
  paymentMethodFromNonceType,
  sortPaymentMethods,
};
