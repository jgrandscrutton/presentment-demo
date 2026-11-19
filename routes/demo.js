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
const { PAYMENT_METHOD_LABELS } = require('../lib/payment-methods');

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

const RECURRING_MODEL_LABELS = Object.freeze({
  merchant_managed: 'Model A · Merchant-managed',
  braintree_subscription: 'Model B · Braintree Subscription',
});

const THREE_D_SECURE_POLICY_LABELS = Object.freeze({
  required: 'Required',
  optional: 'Optional',
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
  const paymentMethods = Array.isArray(account.paymentMethods)
    ? account.paymentMethods
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
    paymentMethods: paymentMethods.map((paymentMethod) => ({
      key: paymentMethod,
      label: PAYMENT_METHOD_LABELS[paymentMethod] || paymentMethod,
    })),
    hasPaymentTypes: paymentTypes.length > 0,
    roleSourceLabel: ROLE_SOURCE_LABELS[account.roleSource] || 'None',
    assignmentStateLabel:
      ASSIGNMENT_LABELS[account.assignmentState] || account.assignmentState || 'Unknown',
    threeDSecurePolicyLabel:
      THREE_D_SECURE_POLICY_LABELS[account.threeDSecurePolicy] || 'Not configured',
    threeDSecurePolicyClass:
      account.threeDSecurePolicy === 'required' ? 'is-required' : 'is-optional',
  };
}

function planDisplayLabel(plan) {
  const cadence = Number.isInteger(plan.billingFrequency) && plan.billingFrequency > 0
    ? `every ${plan.billingFrequency} ${plan.billingFrequency === 1 ? 'month' : 'months'}`
    : 'plan schedule';
  const price = plan.price ? `${plan.price} ${plan.currency}` : plan.currency;
  return `${plan.name} · ${price} · ${cadence}`;
}

function toPlanView(plan, supportedCurrencies) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;

  const id = typeof plan.id === 'string' ? plan.id.trim() : '';
  const currency = typeof plan.currency === 'string'
    ? plan.currency.trim().toUpperCase()
    : '';
  if (
    id === '' ||
    !/^[A-Z]{3}$/.test(currency) ||
    !supportedCurrencies.has(currency)
  ) {
    return null;
  }

  const name = typeof plan.name === 'string' && plan.name.trim() !== ''
    ? plan.name.trim()
    : id;
  const description = typeof plan.description === 'string'
    ? plan.description.trim()
    : '';
  const price = typeof plan.price === 'string' || typeof plan.price === 'number'
    ? String(plan.price).trim()
    : '';
  const parsedFrequency = Number(plan.billingFrequency);
  const billingFrequency = Number.isInteger(parsedFrequency) && parsedFrequency > 0
    ? parsedFrequency
    : null;
  const view = {
    id,
    name,
    description,
    currency,
    price,
    billingFrequency,
  };

  return {
    ...view,
    label: planDisplayLabel(view),
  };
}

function toPlanDiscoveryView(planDiscovery) {
  const source = planDiscovery && typeof planDiscovery === 'object'
    ? planDiscovery
    : {};
  const status = typeof source.status === 'string' && source.status.trim() !== ''
    ? source.status.trim()
    : 'not_run';
  const message = typeof source.message === 'string' && source.message.trim() !== ''
    ? source.message.trim()
    : typeof source.error?.message === 'string' && source.error.message.trim() !== ''
      ? source.error.message.trim()
    : status === 'ok'
      ? 'Plans loaded from Braintree Sandbox.'
      : 'Plan discovery has not completed.';

  return { status, message };
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
    recurringModels: Object.entries(RECURRING_MODEL_LABELS).map(([value, label]) => ({
      value,
      label,
    })),
    initialRecurringModel: 'merchant_managed',
    planOptions: [],
    planAvailability: [],
    hasPlans: false,
    initialPlanId: '',
    planDiscoveryStatus: 'not_run',
    planDiscoveryMessage: 'Plan discovery has not completed.',
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
    const scenarios = [...buildDemoScenarios(catalog)].map((scenario) => {
      let outcomeLabel = 'Expected approval';
      let outcomeClass = 'approved';

      if (scenario.unsupported) {
        outcomeLabel = 'Stops before gateway';
        outcomeClass = 'stop';
      } else if (scenario.disputeScenario) {
        outcomeLabel = 'Expected dispute';
        outcomeClass = 'dispute';
      } else if (scenario.expectedOutcome === 'processor_declined') {
        outcomeLabel = 'Expected decline';
        outcomeClass = 'processor_declined';
      } else if (scenario.expectedOutcome === 'gateway_rejected') {
        outcomeLabel = 'Expected rejection';
        outcomeClass = 'gateway_rejected';
      }

      return {
        ...scenario,
        outcomeLabel,
        outcomeClass,
      };
    });
    const supportedCurrencies = discoveredCurrencies(catalog);
    const supportedCurrencySet = new Set(supportedCurrencies);
    const planOptions = (Array.isArray(state.plans) ? state.plans : [])
      .map((plan) => toPlanView(plan, supportedCurrencySet))
      .filter(Boolean)
      .sort((left, right) =>
        left.currency.localeCompare(right.currency) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
    const planAvailability = supportedCurrencies.map((currency) => {
      const planCount = planOptions.filter((plan) => plan.currency === currency).length;
      return {
        currency,
        available: planCount > 0,
        planCount,
        message: planCount > 0
          ? `${planCount} ${planCount === 1 ? 'plan' : 'plans'} available`
          : 'No plan available',
      };
    });
    const planDiscovery = toPlanDiscoveryView(state.planDiscovery);
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
      planOptions,
      planAvailability,
      hasPlans: planOptions.length > 0,
      initialPlanId:
        planOptions.find((plan) => plan.currency === initialCurrency)?.id || '',
      planDiscoveryStatus: planDiscovery.status,
      planDiscoveryMessage: planDiscovery.message,
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
module.exports.toPlanView = toPlanView;
