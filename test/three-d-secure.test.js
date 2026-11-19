'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THREE_D_SECURE_OPTIONAL,
  THREE_D_SECURE_REQUIRED,
  defaultThreeDSecurePolicy,
  extractThreeDSecureInfo,
  normalizeThreeDSecurePolicy,
  verifyThreeDSecure,
} = require('../lib/three-d-secure');

test('3D Secure policy normalization and defaults are deterministic', () => {
  assert.equal(normalizeThreeDSecurePolicy(' REQUIRED '), THREE_D_SECURE_REQUIRED);
  assert.equal(normalizeThreeDSecurePolicy('optional'), THREE_D_SECURE_OPTIONAL);
  assert.equal(normalizeThreeDSecurePolicy('disabled'), null);
  assert.equal(normalizeThreeDSecurePolicy(null), null);
  assert.equal(defaultThreeDSecurePolicy('EUR'), THREE_D_SECURE_REQUIRED);
  assert.equal(defaultThreeDSecurePolicy(' eur '), THREE_D_SECURE_REQUIRED);
  assert.equal(defaultThreeDSecurePolicy('GBP'), THREE_D_SECURE_OPTIONAL);
});

test('3D Secure extraction exposes only bounded status and liability evidence', () => {
  assert.deepEqual(extractThreeDSecureInfo({
    threeDSecureInfo: {
      status: ' AUTHENTICATE_SUCCESSFUL ',
      liabilityShiftPossible: true,
      liabilityShifted: true,
      cavv: 'must-not-escape',
      dsTransactionId: 'must-not-escape',
    },
  }), {
    status: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  });
  assert.equal(extractThreeDSecureInfo({}), null);
});

test('required Card policy accepts only performed authentication with liability shift', () => {
  const passed = verifyThreeDSecure({
    source: {
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    },
    policy: 'required',
    paymentMethod: 'card',
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.performed, true);

  const missing = verifyThreeDSecure({
    source: {},
    policy: 'required',
    paymentMethod: 'card',
  });
  assert.equal(missing.passed, false);
  assert.equal(missing.liabilityShifted, null);

  const failed = verifyThreeDSecure({
    source: {
      threeDSecureInfo: {
        status: 'authenticate_frictionless_failed',
        liabilityShiftPossible: false,
        liabilityShifted: false,
      },
    },
    policy: 'required',
    paymentMethod: 'card',
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.performed, true);
});

test('optional Card and non-Card methods remain usable without forged proof', () => {
  const optional = verifyThreeDSecure({
    source: {},
    policy: 'optional',
    paymentMethod: 'card',
  });
  assert.equal(optional.passed, true);
  assert.equal(optional.performed, false);

  const paypal = verifyThreeDSecure({
    source: {
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    },
    policy: 'required',
    paymentMethod: 'paypal',
  });
  assert.deepEqual(paypal, {
    passed: true,
    applicable: false,
    required: false,
    performed: false,
    policy: 'required',
    status: null,
    liabilityShiftPossible: null,
    liabilityShifted: null,
    explanation: 'Card 3D Secure does not apply to this payment method.',
  });
});

test('verification rejects unknown policy values', () => {
  assert.throws(
    () => verifyThreeDSecure({ policy: 'disabled', paymentMethod: 'card' }),
    /valid 3D Secure policy/
  );
});
