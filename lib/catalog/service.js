'use strict';

const {
  discoverMerchantAccounts,
  MerchantAccountDiscoveryError,
} = require('../braintree/discover-merchant-accounts');
const { buildMerchantAccountCatalog } = require('./build-catalog');
const { frozenCopy, deepFreeze } = require('./copies');
const {
  CatalogUnavailableError,
  MerchantAccountNotFoundError,
} = require('./errors');
const { loadRoutingPolicy, warning } = require('./policy');
const { validateDemoRatesForCurrencies } = require('../currency');

function assertSandboxEnvironment(environment) {
  const normalized = typeof environment === 'string'
    ? environment.trim().toLowerCase()
    : '';
  if (normalized !== 'sandbox') {
    throw new TypeError('Dynamic merchant account discovery is restricted to Sandbox');
  }
  return 'sandbox';
}

function safeFailure(error) {
  if (error instanceof MerchantAccountDiscoveryError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (
    error instanceof TypeError &&
    /default account|merchant account catalog|discovered merchant account/i.test(error.message)
  ) {
    return {
      code: 'INVALID_DISCOVERY_RESULT',
      message: 'Braintree Sandbox returned an invalid merchant account catalog.',
    };
  }

  if (
    error instanceof TypeError &&
    /demo (?:GBP )?rate|conversion rate/i.test(error.message)
  ) {
    return {
      code: 'DEMO_RATE_CONFIGURATION_INVALID',
      message:
        'The fixed demo-rate configuration does not cover every discovered account currency.',
    };
  }

  return {
    code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED',
    message: 'Unable to load merchant accounts from Braintree Sandbox.',
  };
}

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Catalog clock returned an invalid date');
  }
  return date.toISOString();
}

function createCatalogService({
  gateway,
  merchantId,
  environment = 'sandbox',
  policiesDirectory,
  discover = discoverMerchantAccounts,
  policyLoader = loadRoutingPolicy,
  now = () => new Date(),
} = {}) {
  assertSandboxEnvironment(environment);
  if (typeof merchantId !== 'string' || merchantId.trim() === '') {
    throw new TypeError('A configured Braintree merchant ID is required');
  }
  if (typeof discover !== 'function' || typeof policyLoader !== 'function') {
    throw new TypeError('Catalog discovery and policy loader functions are required');
  }

  const gatewayMerchantId = merchantId.trim();
  let state = deepFreeze({
    status: 'not_run',
    gatewayMerchantId,
    discoveredAt: null,
    error: null,
    warnings: [],
    policyStatus: 'not_loaded',
    accounts: [],
  });
  let refreshPromise = null;

  function getState() {
    return frozenCopy(state);
  }

  function requireAvailableState() {
    if (state.status !== 'ok') {
      throw new CatalogUnavailableError(
        state.error?.message || 'Merchant account discovery has not completed.'
      );
    }
    return state;
  }

  function getMerchantAccounts() {
    return frozenCopy(requireAvailableState().accounts);
  }

  function getPublicMerchantAccounts() {
    return getMerchantAccounts();
  }

  function getMerchantAccountByKey(key) {
    const account = requireAvailableState().accounts.find(
      (candidate) => candidate.key === key
    );
    return account ? frozenCopy(account) : undefined;
  }

  function getMerchantAccountById(merchantAccountId) {
    const account = requireAvailableState().accounts.find(
      (candidate) => candidate.merchantAccountId === merchantAccountId
    );
    return account ? frozenCopy(account) : undefined;
  }

  function getDefaultMerchantAccount() {
    const account = requireAvailableState().accounts.find(
      (candidate) => candidate.isDefault
    );
    return account ? frozenCopy(account) : undefined;
  }

  function hasMerchantAccountId(merchantAccountId) {
    return requireAvailableState().accounts.some(
      (account) =>
        account.merchantAccountId === merchantAccountId &&
        account.status === 'active'
    );
  }

  function assertMerchantAccountId(merchantAccountId) {
    if (!hasMerchantAccountId(merchantAccountId)) {
      throw new MerchantAccountNotFoundError(merchantAccountId);
    }
    return merchantAccountId;
  }

  async function runRefresh() {
    // Clearing accounts before I/O makes refresh fail closed: callers can never
    // route against a stale snapshot while new discovery is in flight.
    state = deepFreeze({
      status: 'not_run',
      gatewayMerchantId,
      discoveredAt: null,
      error: {
        code: 'DISCOVERY_IN_PROGRESS',
        message: 'Merchant account discovery is in progress.',
      },
      warnings: [],
      policyStatus: 'not_loaded',
      accounts: [],
    });

    try {
      const discoveredAccounts = await discover(gateway);
      validateDemoRatesForCurrencies(
        discoveredAccounts.map((account) => account.currency)
      );
      let policyResult;

      try {
        policyResult = await policyLoader({
          merchantId: gatewayMerchantId,
          ...(policiesDirectory ? { policiesDirectory } : {}),
        });
      } catch {
        policyResult = {
          policy: null,
          warnings: [
            warning(
              'POLICY_LOAD_FAILED',
              `The routing policy for gateway ${gatewayMerchantId} could not be loaded; automatic assignment is active.`
            ),
          ],
        };
      }

      const catalog = buildMerchantAccountCatalog({
        merchantId: gatewayMerchantId,
        discoveredAccounts,
        policy: policyResult?.policy || null,
        warnings: Array.isArray(policyResult?.warnings)
          ? policyResult.warnings
          : [],
      });
      const policyStatus = catalog.policyStatus === 'none'
        ? policyResult?.source === 'mismatch'
          ? 'ignored'
          : ['invalid', 'unreadable'].includes(policyResult?.source)
            ? 'rejected'
            : 'none'
        : catalog.policyStatus;

      state = deepFreeze({
        status: 'ok',
        gatewayMerchantId,
        discoveredAt: isoTimestamp(now),
        error: null,
        warnings: catalog.warnings,
        policyStatus,
        accounts: catalog.accounts,
      });
    } catch (error) {
      state = deepFreeze({
        status: 'failed',
        gatewayMerchantId,
        discoveredAt: null,
        error: safeFailure(error),
        warnings: [],
        policyStatus: 'not_loaded',
        accounts: [],
      });
    }

    return getState();
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;

    const currentRefresh = runRefresh();
    refreshPromise = currentRefresh;
    currentRefresh.finally(() => {
      if (refreshPromise === currentRefresh) refreshPromise = null;
    });
    return currentRefresh;
  }

  return Object.freeze({
    refresh,
    getState,
    getMerchantAccounts,
    getPublicMerchantAccounts,
    getMerchantAccountByKey,
    getMerchantAccountById,
    getDefaultMerchantAccount,
    hasMerchantAccountId,
    assertMerchantAccountId,
  });
}

module.exports = {
  assertSandboxEnvironment,
  createCatalogService,
  safeFailure,
};
