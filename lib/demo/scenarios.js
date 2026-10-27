'use strict';

const { getDemoAmount, getSandboxOutcomeAmount } = require('../currency');
const { resolveRoute } = require('../routing/resolve-route');

const UNSUPPORTED_CURRENCY_FALLBACKS = Object.freeze([
  'JPY',
  'CHF',
  'SEK',
  'NOK',
  'PLN',
  'CZK',
]);

function scenarioId(currency, suffix) {
  return `${currency.toLowerCase()}-${suffix}`;
}

function discoveredCurrencies(catalog) {
  return [...new Set(catalog.map((account) => account.currency))]
    .filter((currency) => typeof currency === 'string' && /^[A-Z]{3}$/.test(currency))
    .sort();
}

function describeRoute(decision) {
  if (!decision.matched) {
    return 'No active route · stops before Braintree';
  }

  return `Routes to ${decision.account.label}`;
}

function findSandboxScenarioCurrency(catalog, currencies) {
  const defaultAccount = catalog.find(
    (account) => account?.isDefault === true && account?.status === 'active'
  );
  const candidates = [defaultAccount?.currency, ...currencies].filter(Boolean);

  return candidates.find((currency, index) =>
    candidates.indexOf(currency) === index &&
    resolveRoute({ currency, paymentType: 'one_time' }, catalog).matched
  ) || null;
}

function withPaymentDefaults(scenario) {
  return {
    expectedOutcome: 'approved',
    transactionMode: 'submit_for_settlement',
    ...scenario,
  };
}

function buildDemoScenarios(catalog) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('Routing catalog must be an array');
  }

  const currencies = discoveredCurrencies(catalog);
  const scenarios = [];

  for (const currency of currencies) {
    const oneTime = resolveRoute({ currency, paymentType: 'one_time' }, catalog);
    const recurring = resolveRoute({ currency, paymentType: 'recurring' }, catalog);

    scenarios.push(withPaymentDefaults({
      id: scenarioId(currency, 'one-time'),
      currency,
      paymentType: 'one_time',
      amount: getDemoAmount(currency),
      title: `${currency} one-time purchase`,
      subtitle: describeRoute(oneTime),
    }));

    if (
      oneTime.matched &&
      recurring.matched &&
      oneTime.account.merchantAccountId !== recurring.account.merchantAccountId
    ) {
      scenarios.push(withPaymentDefaults({
        id: scenarioId(currency, 'recurring'),
        currency,
        paymentType: 'recurring',
        amount: getDemoAmount(currency),
        title: `${currency} recurring route`,
        subtitle: `Preview only · routes to ${recurring.account.label}`,
      }));
    }
  }

  const sandboxCurrency = findSandboxScenarioCurrency(catalog, currencies);
  if (sandboxCurrency) {
    scenarios.push(withPaymentDefaults({
      id: scenarioId(sandboxCurrency, 'processor-declined'),
      currency: sandboxCurrency,
      paymentType: 'one_time',
      amount: getSandboxOutcomeAmount(sandboxCurrency, 'processor_declined'),
      title: `${sandboxCurrency} processor decline`,
      subtitle: 'Expected decline · fixed Braintree Sandbox trigger amount',
      expectedOutcome: 'processor_declined',
    }));
    scenarios.push(withPaymentDefaults({
      id: scenarioId(sandboxCurrency, 'gateway-rejected'),
      currency: sandboxCurrency,
      paymentType: 'one_time',
      amount: getSandboxOutcomeAmount(sandboxCurrency, 'gateway_rejected'),
      title: `${sandboxCurrency} gateway rejection`,
      subtitle: 'Expected rejection · fixed Braintree Sandbox trigger amount',
      expectedOutcome: 'gateway_rejected',
    }));
  }

  const unsupportedCurrency = UNSUPPORTED_CURRENCY_FALLBACKS.find(
    (currency) => !currencies.includes(currency)
  );

  if (unsupportedCurrency) {
    scenarios.push(withPaymentDefaults({
      id: scenarioId(unsupportedCurrency, 'no-route'),
      currency: unsupportedCurrency,
      paymentType: 'one_time',
      amount: getDemoAmount(unsupportedCurrency),
      title: `${unsupportedCurrency} unsupported route`,
      subtitle: 'Stops before Braintree',
      unsupported: true,
    }));
  }

  return Object.freeze(scenarios.map((scenario) => Object.freeze({ ...scenario })));
}

module.exports = {
  UNSUPPORTED_CURRENCY_FALLBACKS,
  buildDemoScenarios,
  discoveredCurrencies,
};
