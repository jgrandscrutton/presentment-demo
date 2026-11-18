'use strict';

const express = require('express');

const {
  buildSandboxSubscriptionUrl,
  buildSandboxTransactionUrl,
} = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const eventStore = require('../lib/events/store');
const { formatCurrencyAmount } = require('../lib/currency');
const { redact } = require('../lib/inspector/redact');
const {
  PAYMENT_METHOD_LABELS,
  normalizePaymentMethod,
  paymentMethodFromInstrumentType,
} = require('../lib/payment-methods');

const ALL_FILTER = '__all__';
const LEGACY_FILTER = '__legacy__';
const RESET_CONFIRMATION_HEADER = 'X-Demo-Reset-Confirmation';
const RESET_CONFIRMATION_VALUE = 'clear-local-demo-events';
const RESET_SCOPE = 'local_event_store';

function uniqueStrings(values) {
  return [...new Set(values.filter(
    (value) => typeof value === 'string' && value.trim() !== ''
  ).map((value) => value.trim()))].sort((left, right) => left.localeCompare(right));
}

function safeCatalogState(service) {
  try {
    return service.getState();
  } catch {
    return {
      status: 'failed',
      gatewayMerchantId: null,
      accounts: [],
    };
  }
}

function currentAccounts(service, state) {
  if (state.status !== 'ok') return [];
  try {
    return service.getPublicMerchantAccounts();
  } catch {
    try {
      return service.getMerchantAccounts();
    } catch {
      return Array.isArray(state.accounts) ? structuredClone(state.accounts) : [];
    }
  }
}

function selectedValue(raw, allowed, fallback) {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  return allowed.has(candidate) ? candidate : fallback;
}

function displayTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(date);
}

function displayAmount(event) {
  if (!event.amount || !event.currency) return '—';
  try {
    return formatCurrencyAmount(event.amount, event.currency);
  } catch {
    return `${event.amount} ${event.currency}`;
  }
}

function accountIdFrom(event) {
  return event.responseMerchantAccountId || event.resolvedMerchantAccountId || null;
}

function eventStatus(event) {
  return event.response?.transaction?.status ||
    event.response?.subscription?.status ||
    event.braintreeResult?.transaction?.status ||
    event.subscriptionStatus ||
    event.transactionStatus ||
    null;
}

function paymentMethodLabel(value) {
  if (typeof value !== 'string' || value.trim() === '') return '—';
  const canonical = normalizePaymentMethod(value) || paymentMethodFromInstrumentType(value);
  return PAYMENT_METHOD_LABELS[canonical] || value;
}

function readableThreeDSecureStatus(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const labels = {
    authenticate_successful: 'Authenticated',
    authenticate_attempt_successful: 'Attempted',
    authenticate_rejected: 'Authentication rejected',
    authenticate_error: 'Authentication error',
    authentication_unavailable: 'Authentication unavailable',
    lookup_enrolled: 'Challenge required',
    lookup_not_enrolled: 'Not enrolled',
    lookup_bypassed: 'Lookup bypassed',
    lookup_error: 'Lookup error',
  };
  const status = value.trim().toLowerCase();
  if (labels[status]) return labels[status];

  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function threeDSecureSummary(event) {
  const canonicalMethod = normalizePaymentMethod(event.paymentMethodType) ||
    paymentMethodFromInstrumentType(event.paymentMethodType);
  if (canonicalMethod === 'paypal') {
    return {
      label: 'Not applicable · PayPal',
      className: 'is-neutral',
    };
  }

  const verification = event.threeDSecureVerification &&
    typeof event.threeDSecureVerification === 'object' &&
    !Array.isArray(event.threeDSecureVerification)
    ? event.threeDSecureVerification
    : {};
  const policy = event.threeDSecurePolicy || verification.policy || null;
  const status = event.threeDSecureStatus ?? verification.status ?? null;
  const liabilityShifted = event.liabilityShifted ?? verification.liabilityShifted ?? null;
  const performed = verification.performed;
  const evidenceScope = event.threeDSecureEvidenceScope ||
    verification.evidenceScope ||
    null;
  const transactionAuthenticated =
    event.transactionThreeDSecureAuthenticated ??
    verification.transactionAuthenticated ??
    null;

  if (
    !policy &&
    status === null &&
    liabilityShifted === null &&
    performed === undefined &&
    !evidenceScope &&
    transactionAuthenticated === null
  ) {
    return {
      label: 'Not recorded',
      className: 'is-neutral',
    };
  }

  const policyLabel = policy === 'required'
    ? 'Required'
    : policy === 'optional'
      ? 'Optional'
      : 'Policy not recorded';
  const statusLabel = readableThreeDSecureStatus(status) ||
    (performed === false ? 'Not performed' : 'Status unavailable');
  const liabilityLabel = liabilityShifted === true
    ? 'Liability shifted'
    : liabilityShifted === false
      ? 'Liability not shifted'
      : 'Shift unavailable';
  const failed = verification.passed === false || event.verified === false;
  const recurringEvidence = Boolean(event.recurringModel) ||
    ['recurring', 'recurring_first'].includes(event.transactionSource) ||
    ['subscription', 'subscription_action'].includes(event.type);

  if (!evidenceScope && recurringEvidence) {
    return {
      label: 'Recurring evidence · Scope unavailable · Transaction authentication not established',
      className: failed ? 'is-failed' : 'is-neutral',
    };
  }

  if (evidenceScope === 'vault_setup') {
    return {
      label: `Vault setup · ${statusLabel} · ${
        liabilityShifted === true
          ? 'Setup liability shifted'
          : liabilityShifted === false
            ? 'Setup liability not shifted'
            : 'Setup shift unavailable'
      }`,
      className: failed ? 'is-failed' : 'is-neutral',
    };
  }

  if (transactionAuthenticated === false) {
    const scopeLabel = evidenceScope === 'subscription_transaction'
      ? 'Subscription transaction'
      : evidenceScope === 'vaulted_one_time_transaction'
        ? 'Vaulted one-time transaction'
        : '3D Secure evidence';
    return {
      label: `${scopeLabel} · Transaction not authenticated`,
      className: failed ? 'is-failed' : 'is-neutral',
    };
  }

  return {
    label: `${policyLabel} · ${statusLabel} · ${liabilityLabel}`,
    className: liabilityShifted === true && !failed
      ? 'is-verified'
      : failed
        ? 'is-failed'
        : 'is-neutral',
  };
}

function eventTypeLabel(event) {
  const labels = {
    route_resolution: 'Route decision',
    transaction: 'Transaction',
    transaction_action: `Action · ${event.action || 'operation'}`,
    three_d_secure: '3D Secure',
    vault: 'Vault verification',
    subscription: 'Subscription',
    subscription_action: `Subscription · ${event.action || 'operation'}`,
    webhook: `Webhook · ${event.webhookKind || 'notification'}`,
    dispute_action: `Dispute · ${event.action || 'operation'}`,
  };

  return labels[event.type] || event.type || 'Recorded event';
}

function labelForAccount(accountId, accountMap) {
  if (!accountId) return { label: 'No account', raw: null };
  const account = accountMap.get(accountId);
  return {
    label: account?.label || 'Historical / unavailable account',
    raw: accountId,
  };
}

function option(value, label, selected) {
  return { value, label, selected: value === selected };
}

function buildDemoLogViewModel({
  service,
  store = eventStore,
  query = {},
} = {}) {
  if (!service || typeof service.getState !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  if (!store || typeof store.list !== 'function') {
    throw new TypeError('A readable event store is required');
  }

  const state = safeCatalogState(service);
  const accounts = currentAccounts(service, state);
  const accountMap = new Map(accounts.map((account) => [account.merchantAccountId, account]));
  const allEvents = store.list().map((event) => redact(event));
  const currentGateway = state.gatewayMerchantId || null;
  const historicalGateways = uniqueStrings(
    allEvents.map((event) => event.gatewayMerchantId)
  ).filter((gateway) => gateway !== currentGateway);
  const hasLegacy = allEvents.some((event) => !event.gatewayMerchantId);
  const gatewayValues = new Set([
    ALL_FILTER,
    ...(currentGateway ? [currentGateway] : []),
    ...historicalGateways,
    ...(hasLegacy ? [LEGACY_FILTER] : []),
  ]);
  const defaultGateway = currentGateway || ALL_FILTER;
  const gatewayFilter = selectedValue(query.gateway, gatewayValues, defaultGateway);

  const currencies = uniqueStrings(allEvents.map((event) => event.currency));
  const accountIds = uniqueStrings(allEvents.map(accountIdFrom));
  const currencyFilter = selectedValue(
    query.currency,
    new Set([ALL_FILTER, ...currencies]),
    ALL_FILTER
  );
  const accountFilter = selectedValue(
    query.account,
    new Set([ALL_FILTER, ...accountIds]),
    ALL_FILTER
  );

  const filtered = allEvents.filter((event) => {
    const gatewayMatches = gatewayFilter === ALL_FILTER ||
      (gatewayFilter === LEGACY_FILTER
        ? !event.gatewayMerchantId
        : event.gatewayMerchantId === gatewayFilter);
    const currencyMatches = currencyFilter === ALL_FILTER ||
      event.currency === currencyFilter;
    const accountMatches = accountFilter === ALL_FILTER ||
      accountIdFrom(event) === accountFilter;
    return gatewayMatches && currencyMatches && accountMatches;
  });

  const activeAccountIds = new Set(
    accounts
      .filter((account) => account.status === 'active')
      .map((account) => account.merchantAccountId)
  );
  const rows = filtered.reverse().map((event) => {
    const accountId = accountIdFrom(event);
    const account = labelForAccount(accountId, accountMap);
    const isTransactionRecord = ['transaction', 'transaction_action'].includes(event.type);
    const isRootTransaction = event.type === 'transaction' && !event.relatedEventId;
    const isCurrentGateway = Boolean(
      currentGateway && event.gatewayMerchantId === currentGateway
    );
    const canOperate = Boolean(
      isRootTransaction &&
      isCurrentGateway &&
      event.verified === true &&
      event.braintreeId &&
      activeAccountIds.has(accountId)
    );
    const threeDSecure = threeDSecureSummary(event);

    return {
      ...event,
      timestampLabel: displayTimestamp(event.timestamp),
      amountLabel: displayAmount(event),
      scenarioLabel: event.scenarioId || event.intent?.paymentType || 'Manual',
      eventTypeLabel: eventTypeLabel(event),
      accountLabel: account.label,
      accountId: account.raw,
      statusLabel: eventStatus(event) || event.outcome || 'Recorded',
      paymentMethodLabel: paymentMethodLabel(event.paymentMethodType),
      threeDSecureLabel: threeDSecure.label,
      threeDSecureClass: threeDSecure.className,
      verificationLabel: event.verified === true
        ? 'Verified'
        : event.verified === false
          ? 'Not verified'
          : 'Not applicable',
      verificationClass: event.verified === true
        ? 'is-verified'
        : event.verified === false
          ? 'is-failed'
          : 'is-neutral',
      canOperate,
      operationHeading: isTransactionRecord
        ? 'Live transaction controls'
        : 'Recorded event',
      operationReason: canOperate
        ? 'Checking live Braintree status…'
        : !isTransactionRecord
          ? 'This vault or subscription record is evidence only; use the scenario runner for its lifecycle controls.'
          : !isRootTransaction
          ? 'Only original transaction rows can be operated on.'
          : !isCurrentGateway
            ? 'Historical and legacy gateway events are read-only.'
            : !activeAccountIds.has(accountId)
              ? 'The original merchant account is not active in the current catalog.'
              : 'The original route was not verified.',
      isFollowUp: Boolean(event.relatedEventId),
      inspectorJson: JSON.stringify(event, null, 2),
      controlPanelUrl: event.type === 'subscription' || event.type === 'subscription_action'
        ? buildSandboxSubscriptionUrl(event.gatewayMerchantId, event.subscriptionId)
        : buildSandboxTransactionUrl(event.gatewayMerchantId, event.braintreeId),
    };
  });

  const gatewayOptions = [
    option(ALL_FILTER, 'All gateways', gatewayFilter),
    ...(currentGateway
      ? [option(currentGateway, `Current · ${currentGateway}`, gatewayFilter)]
      : []),
    ...historicalGateways.map((gateway) =>
      option(gateway, `Historical · ${gateway}`, gatewayFilter)
    ),
    ...(hasLegacy
      ? [option(LEGACY_FILTER, 'Legacy · gateway not recorded', gatewayFilter)]
      : []),
  ];
  const currencyOptions = [
    option(ALL_FILTER, 'All currencies', currencyFilter),
    ...currencies.map((currency) => option(currency, currency, currencyFilter)),
  ];
  const accountOptions = [
    option(ALL_FILTER, 'All merchant accounts', accountFilter),
    ...accountIds.map((accountId) => {
      const account = labelForAccount(accountId, accountMap);
      return option(
        accountId,
        `${account.label} · ${accountId}`,
        accountFilter
      );
    }),
  ];

  return {
    title: 'Braintree transaction log',
    catalogAvailable: state.status === 'ok',
    catalogStatus: state.status || 'not_run',
    currentGateway: currentGateway || 'Unavailable',
    selectedGateway: gatewayFilter,
    selectedCurrency: currencyFilter,
    selectedAccount: accountFilter,
    gatewayOptions,
    currencyOptions,
    accountOptions,
    rows,
    hasRows: rows.length > 0,
    visibleCount: rows.length,
    totalCount: allEvents.length,
  };
}

function createDemoLogRouter({
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  store = eventStore,
} = {}) {
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      return res.render('demo-log', {
        layout: false,
        ...buildDemoLogViewModel({
          service: catalogService || getCatalogService(),
          store,
          query: req.query || {},
        }),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reset', (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({
        success: false,
        error: {
          code: 'RESET_JSON_REQUIRED',
          message: 'Local demo reset accepts only an explicit JSON request.',
        },
      });
    }
    if (
      req.get(RESET_CONFIRMATION_HEADER) !== RESET_CONFIRMATION_VALUE ||
      req.body?.scope !== RESET_SCOPE
    ) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'RESET_CONFIRMATION_REQUIRED',
          message: 'Confirm the local-only reset from the transaction log before continuing.',
        },
      });
    }
    if (typeof store?.clear !== 'function') {
      return res.status(503).json({
        success: false,
        error: {
          code: 'RESET_UNAVAILABLE',
          message: 'Local demo history cannot be reset right now. Nothing in Braintree was changed.',
        },
      });
    }

    try {
      const removed = store.clear();
      return res.status(200).json({
        success: true,
        clearedLocalEvents: Number.isInteger(removed) && removed >= 0 ? removed : 0,
        braintreeObjectsChanged: false,
      });
    } catch {
      return res.status(500).json({
        success: false,
        error: {
          code: 'RESET_FAILED',
          message: 'Local demo history could not be cleared. Nothing in Braintree was changed.',
        },
      });
    }
  });

  return router;
}

const router = createDemoLogRouter();
router.ALL_FILTER = ALL_FILTER;
router.LEGACY_FILTER = LEGACY_FILTER;
router.RESET_CONFIRMATION_HEADER = RESET_CONFIRMATION_HEADER;
router.RESET_CONFIRMATION_VALUE = RESET_CONFIRMATION_VALUE;
router.RESET_SCOPE = RESET_SCOPE;
router.buildDemoLogViewModel = buildDemoLogViewModel;
router.createDemoLogRouter = createDemoLogRouter;

module.exports = router;
module.exports.ALL_FILTER = ALL_FILTER;
module.exports.LEGACY_FILTER = LEGACY_FILTER;
module.exports.RESET_CONFIRMATION_HEADER = RESET_CONFIRMATION_HEADER;
module.exports.RESET_CONFIRMATION_VALUE = RESET_CONFIRMATION_VALUE;
module.exports.RESET_SCOPE = RESET_SCOPE;
module.exports.buildDemoLogViewModel = buildDemoLogViewModel;
module.exports.createDemoLogRouter = createDemoLogRouter;
