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
});

let runtimeCatalogService = unavailableService;

function setRuntimeCatalogService(service) {
  if (
    !service ||
    typeof service.getState !== 'function' ||
    typeof service.getMerchantAccounts !== 'function' ||
    typeof service.assertMerchantAccountId !== 'function' ||
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
