'use strict';

const {
  discoverMerchantAccounts,
  MerchantAccountDiscoveryError,
} = require('../braintree/discover-merchant-accounts');
const {
  discoverPlans: discoverBraintreePlans,
  normalizePlan,
  PlanDiscoveryError,
} = require('../braintree/discover-plans');
const { buildMerchantAccountCatalog } = require('./build-catalog');
const { frozenCopy, deepFreeze } = require('./copies');
const {
  CatalogUnavailableError,
  MerchantAccountNotFoundError,
} = require('./errors');
const { loadRoutingPolicy, warning } = require('./policy');
const { validateDemoRatesForCurrencies } = require('../currency');

class PlanCatalogUnavailableError extends CatalogUnavailableError {
  constructor(message = 'The subscription plan catalog is unavailable.') {
    super(message);
    this.name = 'PlanCatalogUnavailableError';
    this.code = 'PLAN_CATALOG_UNAVAILABLE';
  }
}

class PlanNotFoundError extends Error {
  constructor(planId) {
    super(`Subscription plan ${planId} is not available in the current catalog.`);
    this.name = 'PlanNotFoundError';
    this.code = 'PLAN_NOT_FOUND';
    this.planId = planId;
  }
}

class PlanRouteMismatchError extends Error {
  constructor(planId, currency) {
    super(`Subscription plan ${planId} is not available for the ${currency} recurring route.`);
    this.name = 'PlanRouteMismatchError';
    this.code = 'PLAN_ROUTE_MISMATCH';
    this.planId = planId;
    this.currency = currency;
  }
}

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

function safePlanFailure(error) {
  if (error instanceof PlanDiscoveryError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: 'PLAN_DISCOVERY_FAILED',
    message: 'Unable to load subscription plans from Braintree Sandbox.',
  };
}

function normalizePlanWarnings(items) {
  if (!Array.isArray(items)) return [];

  return items.map((item) => warning(
    typeof item?.code === 'string' && /^[A-Z0-9_]+$/.test(item.code)
      ? item.code
      : 'PLAN_WARNING',
    typeof item?.message === 'string' && item.message.trim() !== ''
      ? item.message.trim()
      : 'Subscription plan discovery reported a warning.'
  ));
}

function normalizePlanDiscoveryResult(result) {
  const rawPlans = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray(result.plans)
      ? result.plans
      : null;
  if (!rawPlans) {
    throw new PlanDiscoveryError(
      'Braintree Sandbox returned an invalid subscription plan collection.',
      { code: 'INVALID_PLAN_DISCOVERY_RESULT' }
    );
  }

  const warnings = normalizePlanWarnings(
    Array.isArray(result) ? [] : result.warnings
  );
  const candidates = [];
  rawPlans.forEach((rawPlan, index) => {
    try {
      candidates.push(normalizePlan(rawPlan));
    } catch {
      warnings.push(warning(
        'PLAN_INVALID',
        `Braintree subscription plan at position ${index + 1} was malformed and was excluded.`
      ));
    }
  });

  const counts = new Map();
  for (const plan of candidates) {
    counts.set(plan.id, (counts.get(plan.id) || 0) + 1);
  }

  for (const [planId, count] of counts) {
    if (count > 1) {
      warnings.push(warning(
        'PLAN_DUPLICATE_ID',
        `Braintree returned subscription plan ${planId} more than once; every copy was excluded.`
      ));
    }
  }

  const plans = candidates
    .filter((plan) => counts.get(plan.id) === 1)
    .sort((left, right) => left.id.localeCompare(right.id));

  return { plans, warnings };
}

function eligiblePlansForCatalog(plans, accounts, warnings) {
  const recurringCurrencies = new Set(
    accounts
      .filter(
        (account) =>
          account.status === 'active' &&
          account.paymentTypes.includes('recurring')
      )
      .map((account) => account.currency)
  );

  return plans.filter((plan) => {
    if (recurringCurrencies.has(plan.currency)) return true;

    warnings.push(warning(
      'PLAN_CURRENCY_UNROUTABLE',
      `Subscription plan ${plan.id} uses ${plan.currency}, which has no active recurring route, and was excluded.`
    ));
    return false;
  });
}

function normalizeCurrency(currency) {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
    throw new TypeError('A valid three-letter plan currency is required.');
  }
  return currency.trim().toUpperCase();
}

function normalizePlanId(planId) {
  if (
    typeof planId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(planId.trim())
  ) {
    throw new TypeError('A valid subscription plan ID is required.');
  }
  return planId.trim();
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
  discoverPlans: planDiscoverer = discoverBraintreePlans,
  policyLoader = loadRoutingPolicy,
  now = () => new Date(),
} = {}) {
  assertSandboxEnvironment(environment);
  if (typeof merchantId !== 'string' || merchantId.trim() === '') {
    throw new TypeError('A configured Braintree merchant ID is required');
  }
  if (
    typeof discover !== 'function' ||
    typeof planDiscoverer !== 'function' ||
    typeof policyLoader !== 'function'
  ) {
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
    planDiscovery: {
      status: 'not_run',
      discoveredAt: null,
      error: null,
    },
    plans: [],
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

  function getPlans() {
    return frozenCopy(requireAvailableState().plans);
  }

  function getPlansForCurrency(currency) {
    const normalizedCurrency = normalizeCurrency(currency);
    return frozenCopy(
      requireAvailableState().plans.filter(
        (plan) => plan.currency === normalizedCurrency
      )
    );
  }

  function getPlanById(planId) {
    const normalizedPlanId = normalizePlanId(planId);
    const plan = requireAvailableState().plans.find(
      (candidate) => candidate.id === normalizedPlanId
    );
    return plan ? frozenCopy(plan) : undefined;
  }

  function assertPlanForRoute(planId, currency) {
    const availableState = requireAvailableState();
    if (availableState.planDiscovery.status !== 'ok') {
      throw new PlanCatalogUnavailableError(
        availableState.planDiscovery.error?.message ||
          'Subscription plan discovery has not completed.'
      );
    }

    const normalizedPlanId = normalizePlanId(planId);
    const normalizedCurrency = normalizeCurrency(currency);
    const plan = availableState.plans.find(
      (candidate) => candidate.id === normalizedPlanId
    );
    if (!plan) throw new PlanNotFoundError(normalizedPlanId);
    if (plan.currency !== normalizedCurrency) {
      throw new PlanRouteMismatchError(normalizedPlanId, normalizedCurrency);
    }

    const hasRecurringRoute = availableState.accounts.some(
      (account) =>
        account.status === 'active' &&
        account.currency === normalizedCurrency &&
        account.paymentTypes.includes('recurring')
    );
    if (!hasRecurringRoute) {
      throw new PlanRouteMismatchError(normalizedPlanId, normalizedCurrency);
    }

    return frozenCopy(plan);
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
      planDiscovery: {
        status: 'not_run',
        discoveredAt: null,
        error: null,
      },
      plans: [],
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

      const combinedWarnings = [...catalog.warnings];
      let plans = [];
      let planDiscoveryStatus = 'ok';
      let planDiscoveryError = null;
      try {
        const discoveryResult = normalizePlanDiscoveryResult(
          await planDiscoverer(gateway)
        );
        combinedWarnings.push(...discoveryResult.warnings);
        plans = eligiblePlansForCatalog(
          discoveryResult.plans,
          catalog.accounts,
          combinedWarnings
        );
      } catch (error) {
        planDiscoveryStatus = 'failed';
        planDiscoveryError = safePlanFailure(error);
        combinedWarnings.push(warning(
          'PLAN_DISCOVERY_FAILED',
          'Subscription plans could not be loaded; one-time and merchant-managed recurring demos remain available.'
        ));
      }

      const discoveredAt = isoTimestamp(now);

      state = deepFreeze({
        status: 'ok',
        gatewayMerchantId,
        discoveredAt,
        error: null,
        warnings: combinedWarnings,
        policyStatus,
        accounts: catalog.accounts,
        planDiscovery: {
          status: planDiscoveryStatus,
          discoveredAt: planDiscoveryStatus === 'ok' ? discoveredAt : null,
          error: planDiscoveryError,
        },
        plans,
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
        planDiscovery: {
          status: 'not_run',
          discoveredAt: null,
          error: null,
        },
        plans: [],
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
    getPlans,
    getPlansForCurrency,
    getPlanById,
    assertPlanForRoute,
  });
}

module.exports = {
  assertSandboxEnvironment,
  createCatalogService,
  PlanCatalogUnavailableError,
  PlanNotFoundError,
  PlanRouteMismatchError,
  safeFailure,
  safePlanFailure,
};
