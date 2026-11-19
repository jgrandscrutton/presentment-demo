'use strict';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNSUPPORTED = '[Unsupported value]';

// These names cover gateway credentials, HTTP authorization material, client
// authorizations, vaulted payment method identifiers, and raw card data. Keep
// this list intentionally narrower than a generic "contains token" match so
// demo-safe fields such as paymentInstrumentType and processor response data
// remain useful in the inspector.
const SENSITIVE_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'apisecret',
  'auth',
  'authorization',
  'authorizationfingerprint',
  'authorizationheader',
  'btpayload',
  'btsignature',
  'cardholdername',
  'clientid',
  'clientsecret',
  'clienttoken',
  'cookie',
  'credential',
  'credentials',
  'cryptogram',
  'cvc',
  'cvc2',
  'cvv',
  'cvv2',
  'devicedata',
  'email',
  'emailaddress',
  'expirationdate',
  'expirationmonth',
  'expirationyear',
  'expiry',
  'expirymonth',
  'expiryyear',
  'idtoken',
  'bin',
  'merchantid',
  'networktoken',
  'nonce',
  'pan',
  'passphrase',
  'password',
  'payeremail',
  'paypalemail',
  'paypalpayerid',
  'paymentmethodnonce',
  'paymentmethodtoken',
  'paymenttoken',
  'privatekey',
  'proxyauthorization',
  'publickey',
  'refreshtoken',
  'secret',
  'secretkey',
  'securitycode',
  'sessionid',
  'setcookie',
  'signature',
  'token',
  'tokens',
  'vaulttoken',
  'billingagreementid',
  'uniquenumberidentifier',
]);

const CARD_NUMBER_KEYS = new Set([
  'accountnumber',
  'cardnumber',
  'creditcardnumber',
  'number',
  'primaryaccountnumber',
]);

const SAFE_CARD_SUMMARY_KEYS = new Set([
  'binname',
  'cardtype',
  'commercial',
  'debit',
  'durbinregulated',
  'healthcare',
  'issuingbank',
  'last4',
  'maskednumber',
  'payroll',
  'prepaid',
  'productid',
  'sourcecardlast4',
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);

  // The routed account is a core, intentionally public part of this demo.
  if (normalized === 'merchantaccountid' || SAFE_CARD_SUMMARY_KEYS.has(normalized)) {
    return false;
  }

  return (
    SENSITIVE_KEYS.has(normalized) ||
    CARD_NUMBER_KEYS.has(normalized) ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('nonce') ||
    normalized.endsWith('clienttoken') ||
    normalized.endsWith('paymentmethodtoken') ||
    normalized.endsWith('refreshtoken')
  );
}

function passesLuhnCheck(digits) {
  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function looksLikeCardNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }

  const candidate = String(value).trim();
  if (!/^[0-9 -]+$/.test(candidate)) {
    return false;
  }

  const digits = candidate.replace(/[^0-9]/g, '');
  return digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits);
}

function sanitizeString(value) {
  const trimmed = value.trim();

  if (
    /^(?:basic|bearer)\s+\S+/i.test(trimmed) ||
    /^(?:fake-[a-z0-9_-]*nonce|tokencc_[a-z0-9_-]+)$/i.test(trimmed) ||
    /^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(trimmed) ||
    looksLikeCardNumber(trimmed)
  ) {
    return REDACTED;
  }

  // Avoid persisting secrets echoed inside an error or diagnostic string.
  let sanitized = value.replace(
    /((?:payment[ _-]?method[ _-]?)?nonce\s*[:=]\s*)[^\s,;}]+/gi,
    `$1${REDACTED}`
  );

  sanitized = sanitized.replace(
    /((?:client[ _-]?token|access[ _-]?token|authorization)\s*[:=]\s*)[^\s,;}]+/gi,
    `$1${REDACTED}`
  );
  sanitized = sanitized.replace(
    /((?:(?:private|public|api|secret|access|merchant)[ _-]?(?:key|secret|id)|password|passphrase|credentials?)\s*[:=]\s*)[^\s,;}]+/gi,
    `$1${REDACTED}`
  );
  sanitized = sanitized.replace(
    /\b(?:fake-[a-z0-9_-]*nonce|tokencc_[a-z0-9_-]+)\b/gi,
    REDACTED
  );

  // PayPal account details can arrive under different SDK object shapes. An
  // email address is never required by the demo, so redact it regardless of
  // the containing object's exact name.
  sanitized = sanitized.replace(
    /[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+/g,
    REDACTED
  );

  // Card numbers may be embedded in a processor diagnostic rather than stored
  // under a predictable key. Only Luhn-valid 13–19 digit candidates are
  // replaced, which leaves transaction IDs and ordinary numeric values alone.
  sanitized = sanitized.replace(/\d(?:[ -]?\d){12,18}/g, (candidate) =>
    looksLikeCardNumber(candidate.trim()) ? REDACTED : candidate
  );

  return sanitized;
}

function defineEnumerable(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Return a JSON-safe, deeply redacted copy of a value.
 *
 * The source is never mutated. Class instances are deliberately flattened to
 * plain objects so raw Braintree SDK objects cannot enter the event store.
 * Circular references are represented by a marker rather than retained.
 */
function redact(value, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth
    : 40;

  function visit(current, ancestors, depth) {
    if (depth > maxDepth) {
      return TRUNCATED;
    }

    if (current === null) {
      return null;
    }

    if (typeof current === 'string') {
      return sanitizeString(current);
    }

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        return null;
      }
      return looksLikeCardNumber(current) ? REDACTED : current;
    }

    if (typeof current === 'boolean') {
      return current;
    }

    if (typeof current === 'bigint') {
      return current.toString();
    }

    if (current === undefined) {
      return null;
    }

    if (typeof current === 'function' || typeof current === 'symbol') {
      return UNSUPPORTED;
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? null : current.toISOString();
    }

    if (Buffer.isBuffer(current) || ArrayBuffer.isView(current)) {
      return REDACTED;
    }

    if (current instanceof ArrayBuffer) {
      return REDACTED;
    }

    if (current instanceof RegExp) {
      return current.toString();
    }

    if (ancestors.has(current)) {
      return CIRCULAR;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(current);

    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, nextAncestors, depth + 1));
    }

    if (current instanceof Map) {
      return Array.from(current.entries(), ([key, entry]) => [
        visit(key, nextAncestors, depth + 1),
        visit(entry, nextAncestors, depth + 1),
      ]);
    }

    if (current instanceof Set) {
      return Array.from(current, (entry) => visit(entry, nextAncestors, depth + 1));
    }

    const output = {};

    if (current instanceof Error) {
      defineEnumerable(output, 'name', sanitizeString(current.name));
      defineEnumerable(output, 'message', sanitizeString(current.message));
      if (typeof current.code === 'string' || typeof current.code === 'number') {
        defineEnumerable(output, 'code', visit(current.code, nextAncestors, depth + 1));
      }
    }

    for (const key of Object.keys(current)) {
      if (Object.prototype.hasOwnProperty.call(output, key)) {
        continue;
      }

      if (isSensitiveKey(key)) {
        defineEnumerable(output, key, REDACTED);
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        defineEnumerable(output, key, UNSUPPORTED);
        continue;
      }

      defineEnumerable(
        output,
        key,
        visit(descriptor.value, nextAncestors, depth + 1)
      );
    }

    return output;
  }

  return visit(value, new Set(), 0);
}

module.exports = {
  CIRCULAR,
  REDACTED,
  TRUNCATED,
  redact,
};
