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

// Official Braintree Sandbox dispute trigger. This is test data, not a credential.
const DISPUTE_TEST_CARD = '4023898493988028';

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

function findDisputeScenarioCurrency(catalog, currencies) {
  const defaultAccount = catalog.find(
    (account) => account?.isDefault === true && account?.status === 'active'
  );
  const candidates = [defaultAccount?.currency, ...currencies].filter(Boolean);
  const seen = new Set();

  for (const currency of candidates) {
    if (seen.has(currency)) continue;
    seen.add(currency);
    const decision = resolveRoute({ currency, paymentType: 'one_time' }, catalog);
    if (
      decision.matched &&
      decision.account?.threeDSecurePolicy === 'optional'
    ) {
      return currency;
    }
  }

  return null;
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

    if (recurring.matched) {
      const usesDifferentAccount = Boolean(
        oneTime.matched &&
        oneTime.account.merchantAccountId !== recurring.account.merchantAccountId
      );

      scenarios.push(withPaymentDefaults({
        id: scenarioId(currency, 'recurring'),
        currency,
        paymentType: 'recurring',
        amount: getDemoAmount(currency),
        title: `${currency} recurring billing`,
        subtitle: usesDifferentAccount
          ? `Vault + billing cycles · separate route to ${recurring.account.label}`
          : `Vault + billing cycles · routes to ${recurring.account.label}`,
        recurringModel: 'merchant_managed',
        usesDifferentAccount,
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

  // The Sandbox dispute card is intentionally submitted without 3D Secure.
  // Only advertise the preset where the resolved route permits that flow.
  const disputeCurrency = findDisputeScenarioCurrency(catalog, currencies);
  if (disputeCurrency) {
    scenarios.push(withPaymentDefaults({
      id: scenarioId(disputeCurrency, 'dispute'),
      currency: disputeCurrency,
      paymentType: 'one_time',
      amount: getDemoAmount(disputeCurrency),
      title: `${disputeCurrency} dispute workflow`,
      subtitle: 'Settled sale + open dispute · Braintree Sandbox test card',
      disputeScenario: true,
      sandboxCardNumber: DISPUTE_TEST_CARD,
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
  DISPUTE_TEST_CARD,
  UNSUPPORTED_CURRENCY_FALLBACKS,
  buildDemoScenarios,
  discoveredCurrencies,
};
