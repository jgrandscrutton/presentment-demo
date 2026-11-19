'use strict';

const express = require('express');

const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const eventStore = require('../lib/events/store');
const { PAYMENT_METHOD_LABELS } = require('../lib/payment-methods');

const PAYMENT_TYPE_LABELS = Object.freeze({
  one_time: 'One-time',
  recurring: 'Recurring',
});

const THREE_D_SECURE_LABELS = Object.freeze({
  required: 'Required',
  optional: 'Optional',
});

function safeText(value, fallback = 'Unavailable') {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : fallback;
}

function displayTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(date);
}

function readableWebhookKind(value) {
  const normalized = safeText(value, 'Webhook notification');
  return normalized
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeCatalogState(service, stateOverride) {
  const fallback = {
    status: 'failed',
    gatewayMerchantId: null,
    discoveredAt: null,
    error: { message: 'Merchant account discovery is unavailable.' },
    warnings: [],
    policyStatus: 'not_loaded',
    accounts: [],
    planDiscovery: {
      status: 'not_run',
      discoveredAt: null,
      error: null,
    },
    plans: [],
  };

  try {
    const candidate = stateOverride || service.getState();
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate
      : fallback;
  } catch {
    return fallback;
  }
}

function accountView(account) {
  const paymentTypes = Array.isArray(account?.paymentTypes)
    ? account.paymentTypes.filter((value) => PAYMENT_TYPE_LABELS[value])
    : [];
  const paymentMethods = Array.isArray(account?.paymentMethods)
    ? account.paymentMethods.filter((value) => PAYMENT_METHOD_LABELS[value])
    : [];
  const threeDSecurePolicy = THREE_D_SECURE_LABELS[account?.threeDSecurePolicy]
    ? account.threeDSecurePolicy
    : null;
  const status = safeText(account?.status, 'unknown').toLowerCase();

  return {
    merchantAccountId: safeText(account?.merchantAccountId),
    label: safeText(account?.label, 'Unlabelled account'),
    currency: /^[A-Z]{3}$/.test(account?.currency || '')
      ? account.currency
      : '—',
    status,
    statusLabel: status === 'active' ? 'Active' : safeText(account?.status, 'Unknown'),
    statusClass: status === 'active' ? 'is-passed' : 'is-failed',
    isDefault: account?.isDefault === true,
    routeLabel: paymentTypes.length > 0
      ? paymentTypes.map((value) => PAYMENT_TYPE_LABELS[value]).join(' · ')
      : 'Not assigned',
    routeClass: paymentTypes.length > 0 ? 'is-passed' : 'is-neutral',
    methodLabel: paymentMethods.length > 0
      ? paymentMethods.map((value) => PAYMENT_METHOD_LABELS[value]).join(' · ')
      : 'None enabled',
    methodClass: paymentMethods.length > 0 ? 'is-passed' : 'is-failed',
    threeDSecureLabel: threeDSecurePolicy
      ? THREE_D_SECURE_LABELS[threeDSecurePolicy]
      : 'Not configured',
    threeDSecureClass: threeDSecurePolicy === 'required'
      ? 'is-warning'
      : threeDSecurePolicy === 'optional'
        ? 'is-passed'
        : 'is-failed',
  };
}

function planCoverage(state, accounts) {
  const recurringCurrencies = [...new Set(
    accounts
      .filter(
        (account) =>
          account.status === 'active' &&
          Array.isArray(account.paymentTypes) &&
          account.paymentTypes.includes('recurring') &&
          /^[A-Z]{3}$/.test(account.currency || '')
      )
      .map((account) => account.currency)
  )].sort();
  const plans = Array.isArray(state.plans) ? state.plans : [];

  return recurringCurrencies.map((currency) => {
    const matching = plans.filter((plan) => plan?.currency === currency);
    return {
      currency,
      planCount: matching.length,
      planCountLabel: `${matching.length} ${matching.length === 1 ? 'plan' : 'plans'}`,
      available: matching.length > 0,
      stateClass: matching.length > 0 ? 'is-passed' : 'is-failed',
      planLabels: matching.map((plan) =>
        safeText(plan?.name, safeText(plan?.id, 'Unnamed plan'))
      ),
    };
  });
}

function latestWebhookEvidence(store) {
  let events;
  try {
    events = store.list();
  } catch {
    return {
      eventStoreAvailable: false,
      latestWebhook: null,
    };
  }

  const latest = Array.isArray(events)
    ? events.filter((event) => event?.type === 'webhook').at(-1)
    : null;
  if (!latest) {
    return {
      eventStoreAvailable: true,
      latestWebhook: null,
    };
  }

  return {
    eventStoreAvailable: true,
    latestWebhook: {
      kindLabel: readableWebhookKind(latest.webhookKind),
      timestampLabel: displayTimestamp(
        latest.webhookTimestamp || latest.timestamp
      ),
      receiverLabel: 'Accepted before safe persistence',
      receiverClass: 'is-passed',
      linked:
        latest.verified === true &&
        typeof latest.relatedEventId === 'string' &&
        latest.relatedEventId !== '',
      linkedLabel:
        latest.verified === true &&
        typeof latest.relatedEventId === 'string' &&
        latest.relatedEventId !== ''
          ? 'Verified local audit relationship'
          : 'No verified local audit relationship',
      linkedClass:
        latest.verified === true &&
        typeof latest.relatedEventId === 'string' &&
        latest.relatedEventId !== ''
          ? 'is-passed'
          : 'is-warning',
    },
  };
}

function webhookConfiguration(environment = process.env) {
  const configured = typeof environment.WEBHOOK_PUBLIC_URL === 'string'
    ? environment.WEBHOOK_PUBLIC_URL.trim()
    : '';
  if (configured === '') {
    return {
      state: 'unconfigured',
      stateClass: 'is-warning',
      label: 'Public callback not configured',
      explanation:
        'No WEBHOOK_PUBLIC_URL is set. Start the dedicated receiver and approved HTTPS tunnel before a live webhook demo.',
    };
  }

  try {
    const url = new URL(configured);
    const valid =
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/api/webhooks/braintree' &&
      url.search === '' &&
      url.hash === '' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (!valid) throw new TypeError('Invalid webhook URL');
  } catch {
    return {
      state: 'misconfigured',
      stateClass: 'is-failed',
      label: 'Public callback configuration is invalid',
      explanation:
        'WEBHOOK_PUBLIC_URL must be an HTTPS URL ending at /api/webhooks/braintree. Reachability was not checked.',
    };
  }

  return {
    state: 'unconfirmed',
    stateClass: 'is-warning',
    label: 'Configured · reachability unconfirmed',
    explanation:
      'A public HTTPS callback is configured, but this page does not call it or claim Braintree can currently reach it.',
  };
}

function buildPreflightViewModel({
  service,
  store = eventStore,
  environment = process.env,
  stateOverride,
  refreshResult = null,
} = {}) {
  if (!service || typeof service.getState !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  if (!store || typeof store.list !== 'function') {
    throw new TypeError('A readable event store is required');
  }

  const state = safeCatalogState(service, stateOverride);
  const catalogAvailable = state.status === 'ok';
  const rawAccounts = catalogAvailable && Array.isArray(state.accounts)
    ? state.accounts
    : [];
  const accounts = rawAccounts.map(accountView);
  const activeAccounts = rawAccounts.filter((account) => account?.status === 'active');
  const warnings = Array.isArray(state.warnings)
    ? state.warnings.map((item) => ({
        code: safeText(item?.code, 'CATALOG_WARNING'),
        message: safeText(item?.message, 'The catalog reported a warning.'),
      }))
    : [];
  const coverage = planCoverage(state, rawAccounts);
  const missingPlanCurrencies = coverage.filter((item) => !item.available).length;
  const methods = [...new Set(
    activeAccounts.flatMap((account) =>
      Array.isArray(account.paymentMethods) ? account.paymentMethods : []
    )
  )].filter((method) => PAYMENT_METHOD_LABELS[method]);
  const webhookEvidence = latestWebhookEvidence(store);
  const webhook = webhookConfiguration(environment);
  const planDiscoveryStatus = safeText(state.planDiscovery?.status, 'not_run');

  return {
    title: 'Braintree demo preflight',
    refreshResult,
    catalogAvailable,
    catalogStatus: safeText(state.status, 'not_run'),
    catalogStatusLabel: catalogAvailable ? 'Ready' : 'Unavailable',
    catalogStatusClass: catalogAvailable ? 'is-passed' : 'is-failed',
    gatewayMerchantId: safeText(state.gatewayMerchantId, 'Not configured'),
    discoveredAtLabel: state.discoveredAt
      ? displayTimestamp(state.discoveredAt)
      : 'Not yet discovered',
    discoveryMessage: catalogAvailable
      ? 'Using the latest in-memory Sandbox discovery result.'
      : safeText(
          state.error?.message,
          'Merchant account discovery has not completed.'
        ),
    policyStatusLabel: safeText(state.policyStatus, 'not_loaded').replaceAll('_', ' '),
    policyStatusClass: state.policyStatus === 'applied' ? 'is-passed' : 'is-warning',
    warnings,
    hasWarnings: warnings.length > 0,
    accountCount: accounts.length,
    activeAccountCount: accounts.filter((account) => account.status === 'active').length,
    accounts,
    hasAccounts: accounts.length > 0,
    methodLabel: methods.length > 0
      ? methods.map((method) => PAYMENT_METHOD_LABELS[method]).join(' · ')
      : 'None discovered',
    methodStateClass: methods.length > 0 ? 'is-passed' : 'is-failed',
    planDiscoveryStatus,
    planDiscoveryLabel: planDiscoveryStatus === 'ok'
      ? missingPlanCurrencies === 0
        ? 'Plans ready'
        : 'Plan gaps found'
      : planDiscoveryStatus === 'failed'
        ? 'Plan discovery failed'
        : 'Plans not checked',
    planDiscoveryClass:
      planDiscoveryStatus === 'ok' && missingPlanCurrencies === 0
        ? 'is-passed'
        : planDiscoveryStatus === 'failed'
          ? 'is-failed'
          : 'is-warning',
    planDiscoveryMessage: planDiscoveryStatus === 'failed'
      ? safeText(
          state.planDiscovery?.error?.message,
          'Braintree subscription plans could not be loaded.'
        )
      : coverage.length === 0
        ? 'No active recurring route currently requires plan coverage.'
        : `${coverage.length - missingPlanCurrencies} of ${coverage.length} recurring currencies have at least one discovered plan.`,
    planCoverage: coverage,
    hasPlanCoverage: coverage.length > 0,
    webhook,
    ...webhookEvidence,
  };
}

function createDemoPreflightRouter({
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
  environment = process.env,
} = {}) {
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  const router = express.Router();

  function currentService() {
    return catalogService || getCatalogService();
  }

  router.get('/', (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.render('demo-preflight', {
        layout: false,
        ...buildPreflightViewModel({
          service: currentService(),
          store,
          environment,
        }),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/refresh', async (req, res, next) => {
    const service = currentService();
    try {
      const state = await service.refresh();
      const succeeded = state?.status === 'ok';
      res.set('Cache-Control', 'no-store');
      return res.status(succeeded ? 200 : 503).render('demo-preflight', {
        layout: false,
        ...buildPreflightViewModel({
          service,
          store,
          environment,
          stateOverride: state,
          refreshResult: {
            succeeded,
            stateClass: succeeded ? 'is-passed' : 'is-failed',
            title: succeeded ? 'Read-only checks refreshed' : 'Refresh did not complete',
            message: succeeded
              ? 'Merchant accounts and plans were rediscovered without creating or changing a Braintree payment object.'
              : 'Sandbox discovery remains unavailable. No payment, customer, vault, subscription, dispute, or transaction mutation was requested.',
          },
        }),
      });
    } catch {
      res.set('Cache-Control', 'no-store');
      return res.status(503).render('demo-preflight', {
        layout: false,
        ...buildPreflightViewModel({
          service,
          store,
          environment,
          refreshResult: {
            succeeded: false,
            stateClass: 'is-failed',
            title: 'Refresh could not run',
            message:
              'The read-only discovery request failed safely. No Braintree payment object was created or changed.',
          },
        }),
      });
    }
  });

  return router;
}

const router = createDemoPreflightRouter();
router.buildPreflightViewModel = buildPreflightViewModel;
router.createDemoPreflightRouter = createDemoPreflightRouter;
router.webhookConfiguration = webhookConfiguration;

module.exports = router;
module.exports.buildPreflightViewModel = buildPreflightViewModel;
module.exports.createDemoPreflightRouter = createDemoPreflightRouter;
module.exports.webhookConfiguration = webhookConfiguration;
