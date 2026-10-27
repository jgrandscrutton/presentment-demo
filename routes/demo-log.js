'use strict';

const express = require('express');

const { buildSandboxTransactionUrl } = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const eventStore = require('../lib/events/store');
const { formatCurrencyAmount } = require('../lib/currency');
const { redact } = require('../lib/inspector/redact');

const ALL_FILTER = '__all__';
const LEGACY_FILTER = '__legacy__';

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
    event.braintreeResult?.transaction?.status ||
    event.transactionStatus ||
    null;
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

    return {
      ...event,
      timestampLabel: displayTimestamp(event.timestamp),
      amountLabel: displayAmount(event),
      scenarioLabel: event.scenarioId || event.intent?.paymentType || 'Manual',
      eventTypeLabel: event.type === 'transaction_action'
        ? `Action · ${event.action || 'operation'}`
        : event.type === 'transaction'
          ? 'Transaction'
          : 'Route decision',
      accountLabel: account.label,
      accountId: account.raw,
      statusLabel: eventStatus(event) || event.outcome || 'Recorded',
      paymentMethodLabel: event.paymentMethodType || '—',
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
      operationReason: canOperate
        ? 'Checking live Braintree status…'
        : !isRootTransaction
          ? 'Only original transaction rows can be operated on.'
          : !isCurrentGateway
            ? 'Historical and legacy gateway events are read-only.'
            : !activeAccountIds.has(accountId)
              ? 'The original merchant account is not active in the current catalog.'
              : 'The original route was not verified.',
      isFollowUp: Boolean(event.relatedEventId),
      inspectorJson: JSON.stringify(event, null, 2),
      controlPanelUrl: buildSandboxTransactionUrl(
        event.gatewayMerchantId,
        event.braintreeId
      ),
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

  return router;
}

const router = createDemoLogRouter();
router.ALL_FILTER = ALL_FILTER;
router.LEGACY_FILTER = LEGACY_FILTER;
router.buildDemoLogViewModel = buildDemoLogViewModel;
router.createDemoLogRouter = createDemoLogRouter;

module.exports = router;
module.exports.ALL_FILTER = ALL_FILTER;
module.exports.LEGACY_FILTER = LEGACY_FILTER;
module.exports.buildDemoLogViewModel = buildDemoLogViewModel;
module.exports.createDemoLogRouter = createDemoLogRouter;
