'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UNSUPPORTED_CURRENCY_FALLBACKS,
  buildDemoScenarios,
  discoveredCurrencies,
} = require('../lib/demo/scenarios');
const { validateDemoPaymentAmount } = require('../lib/currency');

function account(
  merchantAccountId,
  currency,
  paymentTypes,
  label = merchantAccountId,
  isDefault = false
) {
  return {
    merchantAccountId,
    currency,
    paymentTypes,
    label,
    status: 'active',
    assignmentState: paymentTypes.length > 0 ? 'assigned' : 'available_not_assigned',
    routingReasons: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'Matched by test policy'])
    ),
    isDefault,
  };
}

test('demo scenarios are generated from discovered currencies in stable order', () => {
  const catalog = [
    account('usd-account', 'USD', ['one_time', 'recurring'], 'United States'),
    account('gbp-account', 'GBP', ['one_time', 'recurring'], 'United Kingdom'),
    account('eur-account', 'EUR', ['one_time', 'recurring'], 'Europe'),
  ];

  assert.deepEqual(discoveredCurrencies(catalog), ['EUR', 'GBP', 'USD']);

  const scenarios = buildDemoScenarios(catalog);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [
      'eur-one-time',
      'gbp-one-time',
      'usd-one-time',
      'eur-processor-declined',
      'eur-gateway-rejected',
      'jpy-no-route',
    ]
  );
  assert.equal(scenarios.at(-1).unsupported, true);
  assert.equal(scenarios.at(-1).currency, 'JPY');
  assert.ok(Object.isFrozen(scenarios));
  assert.ok(scenarios.every(Object.isFrozen));
  assert.ok(
    scenarios.every(
      (scenario) => validateDemoPaymentAmount(
        scenario.amount,
        scenario.currency,
        scenario.expectedOutcome
      ).valid
    )
  );
  assert.ok(scenarios.every((scenario) => scenario.transactionMode === 'submit_for_settlement'));
});

test('a recurring preview is added only when it routes to a different account', () => {
  const catalog = [
    account('usd-sale', 'USD', ['one_time'], 'USD sales'),
    account('usd-recurring', 'USD', ['recurring'], 'USD subscriptions'),
    account('eur-shared', 'EUR', ['one_time', 'recurring'], 'EUR shared'),
  ];

  const scenarios = buildDemoScenarios(catalog);
  assert.ok(scenarios.some((scenario) => scenario.id === 'usd-recurring'));
  assert.equal(
    scenarios.some((scenario) => scenario.id === 'eur-recurring'),
    false
  );
  assert.match(
    scenarios.find((scenario) => scenario.id === 'usd-recurring').subtitle,
    /Preview only.*USD subscriptions/
  );
});

test('a discovered JPY route advances the unsupported scenario to CHF', () => {
  const catalog = [
    account('jpy-account', 'JPY', ['one_time', 'recurring'], 'Japan'),
  ];

  const scenarios = buildDemoScenarios(catalog);
  assert.deepEqual(UNSUPPORTED_CURRENCY_FALLBACKS.slice(0, 2), ['JPY', 'CHF']);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [
      'jpy-one-time',
      'jpy-processor-declined',
      'jpy-gateway-rejected',
      'chf-no-route',
    ]
  );
  assert.equal(scenarios[0].amount.includes('.'), false);
  assert.equal(scenarios[3].currency, 'CHF');
  assert.equal(scenarios[3].unsupported, true);
});

test('sandbox decline scenarios use the connected gateway default currency', () => {
  const catalog = [
    account('eur-account', 'EUR', ['one_time', 'recurring'], 'Europe'),
    account('usd-default', 'USD', ['one_time', 'recurring'], 'US default', true),
  ];

  const scenarios = buildDemoScenarios(catalog);
  const declineScenarios = scenarios.filter(
    (scenario) => scenario.expectedOutcome !== 'approved'
  );

  assert.deepEqual(
    declineScenarios.map((scenario) => ({
      id: scenario.id,
      currency: scenario.currency,
      amount: scenario.amount,
      outcome: scenario.expectedOutcome,
    })),
    [
      {
        id: 'usd-processor-declined',
        currency: 'USD',
        amount: '2001.00',
        outcome: 'processor_declined',
      },
      {
        id: 'usd-gateway-rejected',
        currency: 'USD',
        amount: '5001.00',
        outcome: 'gateway_rejected',
      },
    ]
  );
});

test('unsupported fallback skips every currency already present in discovery', () => {
  const catalog = UNSUPPORTED_CURRENCY_FALLBACKS.map((currency, index) =>
    account(`account-${index}`, currency, ['one_time', 'recurring'])
  );

  const scenarios = buildDemoScenarios(catalog);
  assert.equal(scenarios.some((scenario) => scenario.unsupported), false);
});
