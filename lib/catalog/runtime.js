'use strict';

const { deepFreeze, frozenCopy } = require('./copies');
const { CatalogUnavailableError } = require('./errors');

const unavailableState = deepFreeze({
  status: 'not_run',
  gatewayMerchantId: null,
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

const unavailableService = Object.freeze({
  getState() {
    return frozenCopy(unavailableState);
  },
  refresh() {
    return Promise.resolve(frozenCopy(unavailableState));
  },
  getMerchantAccounts() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getPublicMerchantAccounts() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getMerchantAccountByKey() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getMerchantAccountById() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getDefaultMerchantAccount() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  hasMerchantAccountId() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  assertMerchantAccountId() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getPlans() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getPlansForCurrency() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  getPlanById() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
  assertPlanForRoute() {
    throw new CatalogUnavailableError('Merchant account discovery has not been configured.');
  },
});

let runtimeCatalogService = unavailableService;

function setRuntimeCatalogService(service) {
  if (
    !service ||
    typeof service.getState !== 'function' ||
    typeof service.getMerchantAccounts !== 'function' ||
    typeof service.assertMerchantAccountId !== 'function' ||
    typeof service.getPlans !== 'function' ||
    typeof service.getPlansForCurrency !== 'function' ||
    typeof service.getPlanById !== 'function' ||
    typeof service.assertPlanForRoute !== 'function' ||
    typeof service.refresh !== 'function'
  ) {
    throw new TypeError('A compatible merchant account catalog service is required');
  }
  runtimeCatalogService = service;
  return service;
}

function getRuntimeCatalogService() {
  return runtimeCatalogService;
}

function resetRuntimeCatalogServiceForTests() {
  runtimeCatalogService = unavailableService;
}

module.exports = {
  getRuntimeCatalogService,
  resetRuntimeCatalogServiceForTests,
  setRuntimeCatalogService,
};
