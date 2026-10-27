'use strict';

const {
  BRAINTREE_CURRENCIES,
  BRAINTREE_ZERO_DECIMAL_CURRENCIES,
  DEMO_FX_METADATA,
  DEMO_GBP_RATES,
} = require('../../config/demo-currency');
const {
  SANDBOX_EXPECTED_OUTCOMES,
  SANDBOX_OUTCOME_AMOUNTS,
} = require('../../config/sandbox-scenarios');

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const ZERO_DECIMAL_CURRENCIES = new Set(BRAINTREE_ZERO_DECIMAL_CURRENCIES);
const MINOR_UNIT_FACTOR = 100n;
const TWO_DECIMAL_MAXIMUM_MINOR_UNITS = 199999n;
const ZERO_DECIMAL_MAXIMUM_UNITS = 1999n;

function normalizeCurrencyCode(currency) {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';

  if (!CURRENCY_CODE_PATTERN.test(normalized)) {
    throw new TypeError('currency must be a three-letter currency code');
  }

  return normalized;
}

function getCurrencyDecimalPlaces(currency) {
  const normalized = normalizeCurrencyCode(currency);
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2;
}

function getCurrencyAmountRange(currency) {
  const normalized = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalized);

  return Object.freeze(decimalPlaces === 0
    ? {
        currency: normalized,
        decimalPlaces,
        minimum: '1',
        maximum: '1999',
        step: '1',
      }
    : {
        currency: normalized,
        decimalPlaces,
        minimum: '0.01',
        maximum: '1999.99',
        step: '0.01',
      });
}

function invalidAmount(currency, decimalPlaces, range, code, message) {
  return Object.freeze({
    valid: false,
    amount: null,
    currency,
    decimalPlaces,
    minimum: range.minimum,
    maximum: range.maximum,
    code,
    message,
  });
}

function validateCanonicalAmount(rawAmount, currency) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const range = getCurrencyAmountRange(normalizedCurrency);
  const { decimalPlaces } = range;
  const text = typeof rawAmount === 'number' && Number.isFinite(rawAmount)
    ? String(rawAmount)
    : typeof rawAmount === 'string'
      ? rawAmount.trim()
      : '';

  if (!text) {
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      range,
      'AMOUNT_REQUIRED',
      'Enter an amount.'
    );
  }

  const formatPattern = decimalPlaces === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;

  if (!formatPattern.test(text)) {
    const message = decimalPlaces === 0
      ? `Enter a whole-number amount for ${normalizedCurrency}; decimal points are not allowed.`
      : `Enter an amount for ${normalizedCurrency} with no more than two decimal places.`;

    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      range,
      'AMOUNT_FORMAT_INVALID',
      message
    );
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  const units = decimalPlaces === 0
    ? BigInt(wholePart)
    : (BigInt(wholePart) * MINOR_UNIT_FACTOR) + BigInt(fractionalPart.padEnd(2, '0'));
  const minimumUnits = 1n;
  const maximumUnits = decimalPlaces === 0
    ? ZERO_DECIMAL_MAXIMUM_UNITS
    : TWO_DECIMAL_MAXIMUM_MINOR_UNITS;

  if (units < minimumUnits || units > maximumUnits) {
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      range,
      'AMOUNT_OUT_OF_RANGE',
      `Enter an amount from ${range.minimum} to ${range.maximum} ${normalizedCurrency}.`
    );
  }

  const amount = decimalPlaces === 0
    ? units.toString()
    : `${units / MINOR_UNIT_FACTOR}.${(units % MINOR_UNIT_FACTOR).toString().padStart(2, '0')}`;

  return Object.freeze({
    valid: true,
    amount,
    currency: normalizedCurrency,
    decimalPlaces,
    minimum: range.minimum,
    maximum: range.maximum,
    code: null,
    message: null,
  });
}

function normalizeAmount(rawAmount, currency) {
  const validation = validateCanonicalAmount(rawAmount, currency);
  return validation.valid ? validation.amount : null;
}

function parsePositiveDecimal(value, name) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';

  if (!DECIMAL_PATTERN.test(text)) {
    throw new TypeError(`${name} must be a non-negative decimal value`);
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  const digits = `${wholePart}${fractionalPart}`;

  return {
    numerator: BigInt(digits),
    denominator: 10n ** BigInt(fractionalPart.length),
  };
}

function divideRoundHalfUp(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function formatMinorUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) {
    return units.toString();
  }

  const factor = 10n ** BigInt(decimalPlaces);
  return `${units / factor}.${(units % factor).toString().padStart(decimalPlaces, '0')}`;
}

function toMinorUnits(rawAmount, currency, { allowZero = true } = {}) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);
  const text = typeof rawAmount === 'number' && Number.isFinite(rawAmount)
    ? String(rawAmount)
    : typeof rawAmount === 'string'
      ? rawAmount.trim()
      : '';

  if (!text) {
    throw new TypeError('amount is required');
  }

  const formatPattern = decimalPlaces === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!formatPattern.test(text)) {
    throw new TypeError(
      decimalPlaces === 0
        ? `amount must be a whole number for ${normalizedCurrency}`
        : `amount must have no more than two decimal places for ${normalizedCurrency}`
    );
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  const units = decimalPlaces === 0
    ? BigInt(wholePart)
    : (BigInt(wholePart) * MINOR_UNIT_FACTOR) + BigInt(fractionalPart.padEnd(2, '0'));

  if (!allowZero && units === 0n) {
    throw new RangeError('amount must be greater than zero');
  }

  return units;
}

function fromMinorUnits(rawUnits, currency) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);
  let units;

  if (typeof rawUnits === 'bigint') {
    units = rawUnits;
  } else if (
    typeof rawUnits === 'number' &&
    Number.isSafeInteger(rawUnits) &&
    rawUnits >= 0
  ) {
    units = BigInt(rawUnits);
  } else if (typeof rawUnits === 'string' && /^\d+$/.test(rawUnits.trim())) {
    units = BigInt(rawUnits.trim());
  } else {
    throw new TypeError('minor units must be a non-negative integer');
  }

  if (units < 0n) {
    throw new TypeError('minor units must be a non-negative integer');
  }

  return formatMinorUnits(units, decimalPlaces);
}

function compareCurrencyAmounts(left, right, currency) {
  const leftUnits = toMinorUnits(left, currency);
  const rightUnits = toMinorUnits(right, currency);
  return leftUnits === rightUnits ? 0 : leftUnits < rightUnits ? -1 : 1;
}

function sumCurrencyAmounts(amounts, currency) {
  if (!Array.isArray(amounts)) {
    throw new TypeError('amounts must be an array');
  }

  const total = amounts.reduce(
    (sum, amount) => sum + toMinorUnits(amount, currency),
    0n
  );
  return fromMinorUnits(total, currency);
}

function subtractCurrencyAmounts(minuend, subtrahend, currency) {
  const difference = toMinorUnits(minuend, currency) - toMinorUnits(subtrahend, currency);
  if (difference < 0n) {
    throw new RangeError('currency amount subtraction cannot produce a negative value');
  }

  return fromMinorUnits(difference, currency);
}

function getSandboxOutcomeAmount(currency, expectedOutcome) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const configuredAmount = SANDBOX_OUTCOME_AMOUNTS[expectedOutcome];

  if (!configuredAmount) {
    throw new RangeError(
      `No Braintree Sandbox trigger amount is configured for ${String(expectedOutcome)}`
    );
  }

  return getCurrencyDecimalPlaces(normalizedCurrency) === 0
    ? configuredAmount
    : `${configuredAmount}.00`;
}

function validateDemoPaymentAmount(
  rawAmount,
  currency,
  expectedOutcome = 'approved'
) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  if (expectedOutcome === 'approved') {
    return validateCanonicalAmount(rawAmount, normalizedCurrency);
  }

  const range = getCurrencyAmountRange(normalizedCurrency);
  const { decimalPlaces } = range;
  if (!Object.hasOwn(SANDBOX_OUTCOME_AMOUNTS, expectedOutcome)) {
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      range,
      'EXPECTED_OUTCOME_INVALID',
      'Choose a supported sandbox outcome.'
    );
  }

  const expectedAmount = getSandboxOutcomeAmount(normalizedCurrency, expectedOutcome);
  const sandboxRange = {
    minimum: expectedAmount,
    maximum: expectedAmount,
  };
  const text = typeof rawAmount === 'number' && Number.isFinite(rawAmount)
    ? String(rawAmount)
    : typeof rawAmount === 'string'
      ? rawAmount.trim()
      : '';

  if (!text) {
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      sandboxRange,
      'AMOUNT_REQUIRED',
      'Enter an amount.'
    );
  }

  let normalizedAmount;
  try {
    normalizedAmount = fromMinorUnits(
      toMinorUnits(text, normalizedCurrency, { allowZero: false }),
      normalizedCurrency
    );
  } catch (error) {
    const message = decimalPlaces === 0
      ? `Enter a whole-number amount for ${normalizedCurrency}; decimal points are not allowed.`
      : `Enter an amount for ${normalizedCurrency} with no more than two decimal places.`;
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      sandboxRange,
      'AMOUNT_FORMAT_INVALID',
      error instanceof RangeError ? 'Enter an amount greater than zero.' : message
    );
  }

  if (normalizedAmount !== expectedAmount) {
    return invalidAmount(
      normalizedCurrency,
      decimalPlaces,
      sandboxRange,
      'SANDBOX_AMOUNT_MISMATCH',
      `${SANDBOX_EXPECTED_OUTCOMES[expectedOutcome].label} uses exactly ` +
        `${expectedAmount} ${normalizedCurrency} in the Braintree Sandbox.`
    );
  }

  return Object.freeze({
    valid: true,
    amount: expectedAmount,
    currency: normalizedCurrency,
    decimalPlaces,
    minimum: expectedAmount,
    maximum: expectedAmount,
    code: null,
    message: null,
  });
}

function getDemoRate(currency) {
  const normalized = normalizeCurrencyCode(currency);
  const configured = Object.prototype.hasOwnProperty.call(DEMO_GBP_RATES, normalized);

  if (!configured) {
    throw new RangeError(`No fixed demo GBP rate is configured for ${normalized}`);
  }

  const rate = DEMO_GBP_RATES[normalized];
  const numericRate = Number(rate);

  if (!DECIMAL_PATTERN.test(rate) || !Number.isFinite(numericRate) || numericRate <= 0) {
    throw new TypeError(`${normalized} must have a positive finite demo GBP rate`);
  }

  return Object.freeze({
    baseCurrency: DEMO_FX_METADATA.baseCurrency,
    currency: normalized,
    rate,
    configured: true,
    usesFallback: false,
    kind: DEMO_FX_METADATA.kind,
    label: DEMO_FX_METADATA.label,
    disclaimer: DEMO_FX_METADATA.disclaimer,
  });
}

function validateDemoRatesForCurrencies(currencies, rates = DEMO_GBP_RATES) {
  if (!Array.isArray(currencies) || currencies.length === 0) {
    throw new TypeError('discovered currencies must be a non-empty array');
  }

  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new TypeError('demo GBP rates must be an object');
  }

  const failures = [];

  for (const currency of currencies) {
    let normalized;
    try {
      normalized = normalizeCurrencyCode(currency);
    } catch {
      failures.push(`${String(currency)} is not a three-letter currency code`);
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(rates, normalized)) {
      failures.push(`${normalized} has no fixed demo GBP rate`);
      continue;
    }

    const rate = rates[normalized];
    const text = typeof rate === 'number' && Number.isFinite(rate)
      ? String(rate)
      : typeof rate === 'string'
        ? rate.trim()
        : '';
    const numericRate = Number(text);

    if (!DECIMAL_PATTERN.test(text) || !Number.isFinite(numericRate) || numericRate <= 0) {
      failures.push(`${normalized} must have a positive finite demo GBP rate`);
    }
  }

  if (failures.length > 0) {
    throw new TypeError(`Demo currency configuration is invalid: ${failures.join('; ')}`);
  }

  return true;
}

function convertGbpAmount(gbpAmount, targetCurrency) {
  const normalizedCurrency = normalizeCurrencyCode(targetCurrency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);
  const amount = parsePositiveDecimal(gbpAmount, 'GBP amount');
  const rateDetails = getDemoRate(normalizedCurrency);
  const rate = parsePositiveDecimal(rateDetails.rate, 'demo GBP rate');
  const targetFactor = 10n ** BigInt(decimalPlaces);
  const targetMinorUnits = divideRoundHalfUp(
    amount.numerator * rate.numerator * targetFactor,
    amount.denominator * rate.denominator
  );

  return formatMinorUnits(targetMinorUnits, decimalPlaces);
}

function parseDisplayAmount(amount) {
  const parsed = parsePositiveDecimal(amount, 'amount');
  const numericAmount = Number(parsed.numerator) / Number(parsed.denominator);

  if (!Number.isFinite(numericAmount)) {
    throw new RangeError('amount is too large to display');
  }

  return numericAmount;
}

function formatCurrencyAmount(amount, currency, locale = 'en-GB') {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: normalizedCurrency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(parseDisplayAmount(amount));
}

function getCurrencySymbol(currency, locale = 'en-GB') {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: normalizedCurrency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).formatToParts(0);

  return parts.find((part) => part.type === 'currency')?.value ?? normalizedCurrency;
}

function stableCurrencyNumber(currency, variant) {
  const normalized = normalizeCurrencyCode(currency);
  const parsedVariant = Number.isSafeInteger(variant) ? variant : 0;
  const codeValue = [...normalized].reduce((total, character) => total + character.charCodeAt(0), 0);
  return Math.abs(codeValue + (parsedVariant * 37));
}

function isWithinDemoRange(amount, currency) {
  return validateCanonicalAmount(amount, currency).valid;
}

function getDemoAmount(currency, variant = 0) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const stableNumber = stableCurrencyNumber(normalizedCurrency, variant);
  const pennies = 1000 + (stableNumber % 800);
  const gbpCandidates = Array.from(
    { length: 7 },
    (_, scale) => formatMinorUnits(BigInt(pennies), 2 + scale)
  );

  for (const gbpCandidate of gbpCandidates) {
    const converted = convertGbpAmount(gbpCandidate, normalizedCurrency);
    if (isWithinDemoRange(converted, normalizedCurrency)) {
      return converted;
    }
  }

  return getCurrencyDecimalPlaces(normalizedCurrency) === 0 ? '1' : '0.01';
}

function getVerificationAmount(currency, variant = 0) {
  return getDemoAmount(currency, variant + 101);
}

module.exports = {
  BRAINTREE_CURRENCIES,
  BRAINTREE_ZERO_DECIMAL_CURRENCIES,
  DEMO_FX_METADATA,
  SANDBOX_EXPECTED_OUTCOMES,
  SANDBOX_OUTCOME_AMOUNTS,
  compareCurrencyAmounts,
  convertGbpAmount,
  fromMinorUnits,
  formatCurrencyAmount,
  getCurrencyAmountRange,
  getCurrencyDecimalPlaces,
  getCurrencySymbol,
  getDemoAmount,
  getDemoRate,
  getSandboxOutcomeAmount,
  getVerificationAmount,
  normalizeAmount,
  normalizeCurrencyCode,
  subtractCurrencyAmounts,
  sumCurrencyAmounts,
  toMinorUnits,
  validateCanonicalAmount,
  validateDemoPaymentAmount,
  validateDemoRatesForCurrencies,
};
