'use strict';

const express = require('express');

const { getRuntimeCatalogService } = require('../lib/catalog');
const {
  DEMO_FX_METADATA,
  getCurrencyAmountRange,
  getCurrencySymbol,
  getDemoAmount,
  getDemoRate,
  getSandboxOutcomeAmount,
} = require('../lib/currency');
const {
  buildDemoScenarios,
  discoveredCurrencies,
} = require('../lib/demo/scenarios');

const PAYMENT_TYPE_LABELS = Object.freeze({
  one_time: 'One-time',
  recurring: 'Recurring',
});

const ASSIGNMENT_LABELS = Object.freeze({
  assigned: 'Assigned',
  available_not_assigned: 'Available · not assigned',
  inactive: 'Inactive · not eligible',
});

const ROLE_SOURCE_LABELS = Object.freeze({
  policy: 'Merchant policy',
  auto: 'Automatic',
  mixed: 'Policy + automatic',
});

function currencyDisplayName(currency) {
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'currency' }).of(currency) || currency;
  } catch {
    return currency;
  }
}

function buildCurrencyOption(currency, unsupported = false) {
  const range = getCurrencyAmountRange(currency);
  const rate = getDemoRate(currency);

  return {
    code: currency,
    name: currencyDisplayName(currency),
    label: unsupported
      ? `${currency} — Unsupported route test`
      : `${currency} — ${currencyDisplayName(currency)}`,
    symbol: getCurrencySymbol(currency),
    minimum: range.minimum,
    maximum: range.maximum,
    step: range.step,
    decimalPlaces: range.decimalPlaces,
    demoAmount: getDemoAmount(currency),
    demoRate: `1 ${rate.baseCurrency} = ${rate.rate} ${currency}`,
    processorDeclinedAmount: getSandboxOutcomeAmount(
      currency,
      'processor_declined'
    ),
    gatewayRejectedAmount: getSandboxOutcomeAmount(
      currency,
      'gateway_rejected'
    ),
    unsupported,
  };
}

function toAccountView(account) {
  const paymentTypes = Array.isArray(account.paymentTypes)
    ? account.paymentTypes
    : [];

  return {
    ...account,
    statusClass: `status-${String(account.status || 'unknown').replace(/[^a-z0-9_-]/gi, '-')}`,
    paymentTypes: paymentTypes.map((paymentType) => {
      const source = account.paymentTypeSources?.[paymentType] || account.roleSource;
      return {
        key: paymentType,
        label: PAYMENT_TYPE_LABELS[paymentType] || paymentType,
        source,
        sourceLabel: ROLE_SOURCE_LABELS[source] || 'Unspecified',
      };
    }),
    hasPaymentTypes: paymentTypes.length > 0,
    roleSourceLabel: ROLE_SOURCE_LABELS[account.roleSource] || 'None',
    assignmentStateLabel:
      ASSIGNMENT_LABELS[account.assignmentState] || account.assignmentState || 'Unknown',
  };
}

function baseViewModel(state) {
  return {
    title: 'Braintree Routing Lab',
    catalogAvailable: false,
    catalogStatus: state?.status || 'not_run',
    gatewayMerchantId: state?.gatewayMerchantId || 'Not configured',
    discoveredAt: state?.discoveredAt || null,
    discoveredAtLabel: state?.discoveredAt || 'Not yet discovered',
    policyStatus: state?.policyStatus || 'not_loaded',
    discoveryError:
      state?.error?.message || 'Merchant account discovery has not completed.',
    warnings: [],
    hasWarnings: false,
    accounts: [],
    accountCount: 0,
    activeAccountCount: 0,
    currencyCount: 0,
    currenciesLabel: 'Unavailable',
    currencyOptions: [],
    scenarios: [],
    firstScenario: null,
    initialScenarioId: 'unavailable',
    initialCurrency: '',
    initialPaymentType: 'one_time',
    initialTransactionMode: 'submit_for_settlement',
    initialExpectedOutcome: 'approved',
    initialAmount: '',
    initialCurrencySymbol: '—',
    initialDemoRate: 'Demo rate unavailable',
    initialInputMode: 'decimal',
    initialMinimum: '0.01',
    initialMaximum: '1999.99',
    initialStep: '0.01',
    demoFxLabel: DEMO_FX_METADATA.label,
    demoFxDisclaimer: DEMO_FX_METADATA.disclaimer,
  };
}

function buildDemoViewModel(catalogService = getRuntimeCatalogService()) {
  let state;

  try {
    state = catalogService.getState();
  } catch {
    state = {
      status: 'failed',
      error: { message: 'Merchant account discovery is unavailable.' },
    };
  }

  const model = baseViewModel(state);
  if (state?.status !== 'ok') {
    return model;
  }

  try {
    const catalog = catalogService.getPublicMerchantAccounts();
    const accounts = catalog.map(toAccountView);
    const scenarios = [...buildDemoScenarios(catalog)];
    const supportedCurrencies = discoveredCurrencies(catalog);
    const unsupportedScenario = scenarios.find((scenario) => scenario.unsupported);
    const currencyOptions = supportedCurrencies.map((currency) =>
      buildCurrencyOption(currency)
    );

    if (unsupportedScenario) {
      currencyOptions.push(buildCurrencyOption(unsupportedScenario.currency, true));
    }

    const firstScenario = scenarios[0] || null;
    const initialCurrency = firstScenario?.currency || currencyOptions[0]?.code || '';
    const initialCurrencyOption = currencyOptions.find(
      (currency) => currency.code === initialCurrency
    );
    const warnings = Array.isArray(state.warnings)
      ? state.warnings.map((item) => ({
          code: item?.code || 'CATALOG_WARNING',
          message: item?.message || 'The discovered catalog has a warning.',
        }))
      : [];

    return {
      ...model,
      catalogAvailable: true,
      discoveryError: null,
      warnings,
      hasWarnings: warnings.length > 0,
      accounts,
      accountCount: accounts.length,
      activeAccountCount: accounts.filter((account) => account.status === 'active').length,
      currencyCount: supportedCurrencies.length,
      currenciesLabel: supportedCurrencies.join(' · '),
      currencyOptions,
      scenarios,
      firstScenario,
      initialScenarioId: firstScenario?.id || 'manual',
      initialCurrency,
      initialPaymentType: firstScenario?.paymentType || 'one_time',
      initialTransactionMode:
        firstScenario?.transactionMode || 'submit_for_settlement',
      initialExpectedOutcome: firstScenario?.expectedOutcome || 'approved',
      initialAmount:
        firstScenario?.amount || initialCurrencyOption?.demoAmount || '',
      initialCurrencySymbol: initialCurrencyOption?.symbol || initialCurrency || '—',
      initialDemoRate: initialCurrencyOption?.demoRate || 'Demo rate unavailable',
      initialInputMode: initialCurrencyOption?.step === '1' ? 'numeric' : 'decimal',
      initialMinimum: initialCurrencyOption?.minimum || '0.01',
      initialMaximum: initialCurrencyOption?.maximum || '1999.99',
      initialStep: initialCurrencyOption?.step || '0.01',
    };
  } catch {
    return {
      ...model,
      catalogStatus: 'failed',
      discoveryError: 'The discovered merchant account catalog could not be prepared for the demo.',
    };
  }
}

function createDemoRouter({ getCatalogService = getRuntimeCatalogService } = {}) {
  if (typeof getCatalogService !== 'function') {
    throw new TypeError('getCatalogService must be a function');
  }

  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('demo', {
      layout: false,
      ...buildDemoViewModel(getCatalogService()),
    });
  });

  return router;
}

const router = createDemoRouter();
router.buildDemoViewModel = buildDemoViewModel;
router.createDemoRouter = createDemoRouter;

module.exports = router;
module.exports.buildDemoViewModel = buildDemoViewModel;
module.exports.createDemoRouter = createDemoRouter;
