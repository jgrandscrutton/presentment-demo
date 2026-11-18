'use strict';

const THREE_D_SECURE_OPTIONAL = 'optional';
const THREE_D_SECURE_REQUIRED = 'required';
const THREE_D_SECURE_POLICIES = new Set([
  THREE_D_SECURE_OPTIONAL,
  THREE_D_SECURE_REQUIRED,
]);

function normalizeThreeDSecurePolicy(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return THREE_D_SECURE_POLICIES.has(normalized) ? normalized : null;
}

function defaultThreeDSecurePolicy(currency) {
  return typeof currency === 'string' && currency.trim().toUpperCase() === 'EUR'
    ? THREE_D_SECURE_REQUIRED
    : THREE_D_SECURE_OPTIONAL;
}

function normalizeStatus(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().toLowerCase()
    : null;
}

function extractThreeDSecureInfo(source) {
  const candidate = source?.threeDSecureInfo &&
    typeof source.threeDSecureInfo === 'object' &&
    !Array.isArray(source.threeDSecureInfo)
    ? source.threeDSecureInfo
    : source && typeof source === 'object' && !Array.isArray(source) && (
      Object.hasOwn(source, 'status') ||
      Object.hasOwn(source, 'liabilityShiftPossible') ||
      Object.hasOwn(source, 'liabilityShifted')
    )
      ? source
      : null;

  if (!candidate) return null;

  return Object.freeze({
    status: normalizeStatus(candidate.status),
    liabilityShiftPossible:
      typeof candidate.liabilityShiftPossible === 'boolean'
        ? candidate.liabilityShiftPossible
        : null,
    liabilityShifted:
      typeof candidate.liabilityShifted === 'boolean'
        ? candidate.liabilityShifted
        : null,
  });
}

function verifyThreeDSecure({ source, policy, paymentMethod } = {}) {
  const normalizedPolicy = normalizeThreeDSecurePolicy(policy);
  if (!normalizedPolicy) {
    throw new TypeError('A valid 3D Secure policy is required');
  }

  if (paymentMethod !== 'card') {
    return Object.freeze({
      passed: true,
      applicable: false,
      required: false,
      performed: false,
      policy: normalizedPolicy,
      status: null,
      liabilityShiftPossible: null,
      liabilityShifted: null,
      explanation: 'Card 3D Secure does not apply to this payment method.',
    });
  }

  const info = extractThreeDSecureInfo(source);
  const required = normalizedPolicy === THREE_D_SECURE_REQUIRED;
  const performed = Boolean(info?.status);
  const passed = !required || Boolean(
    performed && info.liabilityShifted === true
  );

  let explanation;
  if (required && passed) {
    explanation = 'Braintree proved the required 3D Secure authentication and liability shift.';
  } else if (required && !performed) {
    explanation = 'The selected route requires 3D Secure, but the card nonce has no authentication evidence.';
  } else if (required) {
    explanation = 'The selected route requires a successful 3D Secure liability shift, but authentication did not complete successfully.';
  } else if (performed && info.liabilityShifted === true) {
    explanation = 'Optional 3D Secure was completed and liability shifted.';
  } else if (performed) {
    explanation = 'Optional 3D Secure was attempted without a liability shift.';
  } else {
    explanation = '3D Secure is optional on this route and was not performed.';
  }

  return Object.freeze({
    passed,
    applicable: true,
    required,
    performed,
    policy: normalizedPolicy,
    status: info?.status ?? null,
    liabilityShiftPossible: info?.liabilityShiftPossible ?? null,
    liabilityShifted: info?.liabilityShifted ?? null,
    explanation,
  });
}

module.exports = {
  THREE_D_SECURE_OPTIONAL,
  THREE_D_SECURE_POLICIES,
  THREE_D_SECURE_REQUIRED,
  defaultThreeDSecurePolicy,
  extractThreeDSecureInfo,
  normalizeThreeDSecurePolicy,
  verifyThreeDSecure,
};
