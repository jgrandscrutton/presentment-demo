'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BRAINTREE_CURRENCIES,
  BRAINTREE_ZERO_DECIMAL_CURRENCIES,
  DEMO_FX_METADATA,
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
  subtractCurrencyAmounts,
  sumCurrencyAmounts,
  toMinorUnits,
  validateCanonicalAmount,
  validateDemoPaymentAmount,
  validateDemoRatesForCurrencies,
} = require('../lib/currency');
const {
  DEMO_GBP_RATES,
} = require('../config/demo-currency');

test('fixed demo rates cover every currency in the Braintree reference', () => {
  assert.equal(BRAINTREE_CURRENCIES.length, 134);
  assert.deepEqual(BRAINTREE_CURRENCIES, Object.keys(DEMO_GBP_RATES));
  assert.equal(new Set(BRAINTREE_CURRENCIES).size, BRAINTREE_CURRENCIES.length);

  for (const currency of BRAINTREE_CURRENCIES) {
    const rate = getDemoRate(currency);
    assert.match(rate.rate, /^\d+(?:\.\d+)?$/);
    assert.ok(Number(rate.rate) > 0);
    assert.equal(rate.configured, true);
    assert.equal(rate.usesFallback, false);
  }

  assert.equal(DEMO_FX_METADATA.baseCurrency, 'GBP');
  assert.match(DEMO_FX_METADATA.label, /demo/i);
  assert.match(DEMO_FX_METADATA.label, /not live FX/i);
  assert.match(DEMO_FX_METADATA.disclaimer, /not live foreign-exchange/i);
});

test('unconfigured currencies fail closed instead of receiving an arbitrary rate', () => {
  assert.throws(
    () => getDemoRate('xyz'),
    /No fixed demo GBP rate is configured for XYZ/
  );
  assert.throws(
    () => convertGbpAmount('10', 'XYZ'),
    /No fixed demo GBP rate is configured for XYZ/
  );
});

test('startup validation requires a positive finite configured rate for every discovered currency', () => {
  assert.equal(validateDemoRatesForCurrencies(['GBP', 'eur', 'JPY']), true);
  assert.throws(
    () => validateDemoRatesForCurrencies(['GBP', 'XYZ']),
    /XYZ has no fixed demo GBP rate/
  );
  assert.throws(
    () => validateDemoRatesForCurrencies(['GBP'], { GBP: '0' }),
    /GBP must have a positive finite demo GBP rate/
  );
  assert.throws(
    () => validateDemoRatesForCurrencies(['GBP'], { GBP: 'Infinity' }),
    /GBP must have a positive finite demo GBP rate/
  );
  assert.throws(
    () => validateDemoRatesForCurrencies(['GBP'], { GBP: Number.NaN }),
    /GBP must have a positive finite demo GBP rate/
  );
  assert.throws(
    () => validateDemoRatesForCurrencies([]),
    /discovered currencies must be a non-empty array/
  );
});

test('decimal places follow Braintree zero-decimal currency rules', () => {
  assert.equal(BRAINTREE_ZERO_DECIMAL_CURRENCIES.length, 17);
  assert.equal(getCurrencyDecimalPlaces('JPY'), 0);
  assert.equal(getCurrencyDecimalPlaces('jpy'), 0);
  assert.equal(getCurrencyDecimalPlaces('VND'), 0);
  assert.equal(getCurrencyDecimalPlaces('GBP'), 2);
  assert.equal(getCurrencyDecimalPlaces('HUF'), 2);
  assert.equal(getCurrencyDecimalPlaces('TWD'), 2);
  assert.throws(() => getCurrencyDecimalPlaces('GB'), /three-letter currency code/);
});

test('amount ranges scale to zero- and two-decimal currencies', () => {
  assert.deepEqual(getCurrencyAmountRange('GBP'), {
    currency: 'GBP',
    decimalPlaces: 2,
    minimum: '0.01',
    maximum: '1999.99',
    step: '0.01',
  });
  assert.deepEqual(getCurrencyAmountRange('JPY'), {
    currency: 'JPY',
    decimalPlaces: 0,
    minimum: '1',
    maximum: '1999',
    step: '1',
  });
  assert.ok(Object.isFrozen(getCurrencyAmountRange('USD')));
});

test('canonical validation accepts and normalizes two-decimal amounts', () => {
  assert.deepEqual(validateCanonicalAmount('10', 'GBP'), {
    valid: true,
    amount: '10.00',
    currency: 'GBP',
    decimalPlaces: 2,
    minimum: '0.01',
    maximum: '1999.99',
    code: null,
    message: null,
  });
  assert.equal(validateCanonicalAmount('10.1', 'USD').amount, '10.10');
  assert.equal(validateCanonicalAmount('10.11', 'EUR').amount, '10.11');
  assert.equal(validateCanonicalAmount('0.01', 'EUR').valid, true);
  assert.equal(validateCanonicalAmount('1999.99', 'EUR').valid, true);
  assert.equal(normalizeAmount(25, 'USD'), '25.00');
});

test('canonical validation rejects malformed and out-of-range two-decimal amounts', () => {
  assert.equal(validateCanonicalAmount('10.001', 'GBP').code, 'AMOUNT_FORMAT_INVALID');
  assert.equal(validateCanonicalAmount('10.', 'GBP').code, 'AMOUNT_FORMAT_INVALID');
  assert.equal(validateCanonicalAmount('-1', 'GBP').code, 'AMOUNT_FORMAT_INVALID');
  assert.equal(validateCanonicalAmount('1e2', 'GBP').code, 'AMOUNT_FORMAT_INVALID');
  assert.equal(validateCanonicalAmount('0', 'GBP').code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal(validateCanonicalAmount('2000', 'GBP').code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal(normalizeAmount('2000', 'GBP'), null);
});

test('zero-decimal validation rejects every decimal point and enforces its range', () => {
  assert.equal(validateCanonicalAmount('1', 'JPY').amount, '1');
  assert.equal(validateCanonicalAmount('1999', 'JPY').amount, '1999');

  for (const amount of ['1.0', '10.00', '0.5', '1999.0']) {
    const result = validateCanonicalAmount(amount, 'JPY');
    assert.equal(result.valid, false);
    assert.equal(result.code, 'AMOUNT_FORMAT_INVALID');
    assert.match(result.message, /decimal points are not allowed/);
  }

  assert.equal(validateCanonicalAmount('0', 'JPY').code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal(validateCanonicalAmount('2000', 'JPY').code, 'AMOUNT_OUT_OF_RANGE');
});

test('GBP conversion rounds half up at the target currency precision', () => {
  assert.equal(convertGbpAmount('19.00', 'GBP'), '19.00');
  assert.equal(convertGbpAmount('10', 'USD'), '12.90');
  assert.equal(convertGbpAmount('10', 'EUR'), '11.80');
  assert.equal(convertGbpAmount('10', 'JPY'), '1910');
  assert.equal(convertGbpAmount('0.01', 'JPY'), '2');
  assert.equal(convertGbpAmount('0.005', 'GBP'), '0.01');
  assert.equal(convertGbpAmount('0.004', 'GBP'), '0.00');
});

test('Intl helpers use Braintree precision and expose a currency symbol', () => {
  const formattedGbp = formatCurrencyAmount('19', 'GBP', 'en-GB');
  const formattedJpy = formatCurrencyAmount('1910', 'JPY', 'en-GB');

  assert.match(formattedGbp, /£19\.00/);
  assert.match(formattedJpy, /1,910/);
  assert.doesNotMatch(formattedJpy, /\.00/);
  assert.equal(getCurrencySymbol('GBP', 'en-GB'), '£');
  assert.ok(getCurrencySymbol('JPY', 'en-GB').length > 0);

  for (const currency of BRAINTREE_CURRENCIES) {
    const converted = convertGbpAmount('19', currency);
    assert.ok(formatCurrencyAmount(converted, currency, 'en-GB').length > 0, currency);
    assert.ok(getCurrencySymbol(currency, 'en-GB').length > 0, currency);
  }
});

test('demo and verification amounts are deterministic and valid for every currency', () => {
  for (const currency of BRAINTREE_CURRENCIES) {
    const firstDemoAmount = getDemoAmount(currency);
    const secondDemoAmount = getDemoAmount(currency);
    const verificationAmount = getVerificationAmount(currency);

    assert.equal(firstDemoAmount, secondDemoAmount);
    assert.equal(validateCanonicalAmount(firstDemoAmount, currency).valid, true, currency);
    assert.equal(validateCanonicalAmount(verificationAmount, currency).valid, true, currency);
  }

  assert.doesNotMatch(getDemoAmount('JPY'), /\./);
  assert.doesNotMatch(getVerificationAmount('VND'), /\./);
  assert.match(getDemoAmount('USD'), /^\d+\.\d{2}$/);
});

test('sandbox outcome amounts are fixed triggers rather than converted demo prices', () => {
  assert.deepEqual(SANDBOX_OUTCOME_AMOUNTS, {
    processor_declined: '2001',
    gateway_rejected: '5001',
  });
  assert.equal(getSandboxOutcomeAmount('GBP', 'processor_declined'), '2001.00');
  assert.equal(getSandboxOutcomeAmount('USD', 'gateway_rejected'), '5001.00');
  assert.equal(getSandboxOutcomeAmount('JPY', 'processor_declined'), '2001');
  assert.equal(getSandboxOutcomeAmount('VND', 'gateway_rejected'), '5001');
  assert.throws(
    () => getSandboxOutcomeAmount('GBP', 'approved'),
    /No Braintree Sandbox trigger amount/
  );
});

test('demo payment validation preserves approved ranges and requires exact sandbox triggers', () => {
  assert.equal(validateDemoPaymentAmount('19', 'GBP', 'approved').amount, '19.00');
  assert.equal(
    validateDemoPaymentAmount('2001', 'GBP', 'approved').code,
    'AMOUNT_OUT_OF_RANGE'
  );

  assert.deepEqual(
    validateDemoPaymentAmount('2001', 'USD', 'processor_declined'),
    {
      valid: true,
      amount: '2001.00',
      currency: 'USD',
      decimalPlaces: 2,
      minimum: '2001.00',
      maximum: '2001.00',
      code: null,
      message: null,
    }
  );
  assert.equal(
    validateDemoPaymentAmount('2001.01', 'USD', 'processor_declined').code,
    'SANDBOX_AMOUNT_MISMATCH'
  );
  assert.equal(
    validateDemoPaymentAmount('5001', 'JPY', 'gateway_rejected').amount,
    '5001'
  );
  assert.equal(
    validateDemoPaymentAmount('5001.00', 'JPY', 'gateway_rejected').code,
    'AMOUNT_FORMAT_INVALID'
  );
  assert.equal(
    validateDemoPaymentAmount('19.00', 'GBP', 'not-a-scenario').code,
    'EXPECTED_OUTCOME_INVALID'
  );
});

test('minor-unit helpers perform exact capture and refund arithmetic', () => {
  assert.equal(toMinorUnits('10.25', 'GBP'), 1025n);
  assert.equal(toMinorUnits('10.2', 'GBP'), 1020n);
  assert.equal(toMinorUnits('10', 'JPY'), 10n);
  assert.equal(fromMinorUnits(1025n, 'GBP'), '10.25');
  assert.equal(fromMinorUnits(10n, 'JPY'), '10');
  assert.equal(compareCurrencyAmounts('9.99', '10', 'USD'), -1);
  assert.equal(compareCurrencyAmounts('10.00', '10', 'USD'), 0);
  assert.equal(compareCurrencyAmounts('11', '10.00', 'USD'), 1);
  assert.equal(sumCurrencyAmounts(['1.20', '2.30', '0'], 'GBP'), '3.50');
  assert.equal(subtractCurrencyAmounts('10.00', '3.21', 'GBP'), '6.79');
  assert.equal(subtractCurrencyAmounts('10', '3', 'JPY'), '7');

  assert.throws(() => toMinorUnits('1.001', 'GBP'), /two decimal places/);
  assert.throws(() => toMinorUnits('1.00', 'JPY'), /whole number/);
  assert.throws(
    () => subtractCurrencyAmounts('3.00', '3.01', 'GBP'),
    /cannot produce a negative/
  );
});
