'use strict';

const {
  getCurrencyDecimalPlaces,
  normalizeCurrencyCode,
} = require('../currency');

function amountText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parseAmount(value, currency, { allowZero = false } = {}) {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(normalizedCurrency);
  const text = amountText(value);
  const pattern = decimalPlaces === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;

  if (!pattern.test(text)) {
    throw new TypeError(
      decimalPlaces === 0
        ? `${normalizedCurrency} amounts must be whole numbers.`
        : `${normalizedCurrency} amounts must use no more than two decimal places.`
    );
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  const factor = 10n ** BigInt(decimalPlaces);
  const units = (BigInt(wholePart) * factor) + BigInt(
    decimalPlaces === 0 ? '0' : fractionalPart.padEnd(decimalPlaces, '0')
  );

  if (units < 0n || (!allowZero && units === 0n)) {
    throw new RangeError('Amount must be greater than zero.');
  }

  return Object.freeze({
    currency: normalizedCurrency,
    decimalPlaces,
    units,
    amount: formatUnits(units, decimalPlaces),
  });
}

function formatUnits(units, decimalPlaces) {
  if (typeof units !== 'bigint' || units < 0n) {
    throw new TypeError('units must be a non-negative bigint');
  }
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new TypeError('decimalPlaces must be a non-negative integer');
  }
  if (decimalPlaces === 0) return units.toString();

  const factor = 10n ** BigInt(decimalPlaces);
  return `${units / factor}.${(units % factor).toString().padStart(decimalPlaces, '0')}`;
}

function subtractAmounts(total, deductions, currency) {
  const parsedTotal = parseAmount(total, currency, { allowZero: true });
  const remainingUnits = (Array.isArray(deductions) ? deductions : []).reduce(
    (remaining, deduction) =>
      remaining - parseAmount(deduction, parsedTotal.currency, { allowZero: true }).units,
    parsedTotal.units
  );

  if (remainingUnits < 0n) {
    throw new RangeError('Refunded amount exceeds the original transaction amount.');
  }

  return Object.freeze({
    currency: parsedTotal.currency,
    decimalPlaces: parsedTotal.decimalPlaces,
    units: remainingUnits,
    amount: formatUnits(remainingUnits, parsedTotal.decimalPlaces),
  });
}

function validateActionAmount(value, maximum, currency) {
  let candidate;
  let limit;
  try {
    candidate = parseAmount(value, currency);
    limit = parseAmount(maximum, currency, { allowZero: true });
  } catch (error) {
    return Object.freeze({
      valid: false,
      amount: null,
      code: error instanceof RangeError ? 'AMOUNT_OUT_OF_RANGE' : 'AMOUNT_FORMAT_INVALID',
      message: error.message,
    });
  }

  if (candidate.units > limit.units) {
    return Object.freeze({
      valid: false,
      amount: null,
      code: 'AMOUNT_EXCEEDS_AVAILABLE',
      message: `Amount must not exceed ${limit.amount} ${limit.currency}.`,
    });
  }

  return Object.freeze({
    valid: true,
    amount: candidate.amount,
    code: null,
    message: null,
  });
}

module.exports = {
  formatUnits,
  parseAmount,
  subtractAmounts,
  validateActionAmount,
};
