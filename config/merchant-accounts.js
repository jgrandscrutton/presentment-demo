'use strict';

const {
  getRuntimeCatalogService,
  setRuntimeCatalogService,
} = require('../lib/catalog/runtime');
const { validateMerchantAccounts } = require('../lib/catalog/validate-catalog');

/**
 * Install the catalog service created for the configured Braintree gateway.
 * Keeping this tiny compatibility module lets existing callers use the Stage 1
 * accessors without putting gateway-specific account data in source code.
 */
function configureCatalogService(catalogService) {
  return setRuntimeCatalogService(catalogService);
}

function getMerchantAccounts() {
  return getRuntimeCatalogService().getMerchantAccounts();
}

function getPublicMerchantAccounts() {
  return getRuntimeCatalogService().getPublicMerchantAccounts();
}

function getMerchantAccountByKey(key) {
  return getRuntimeCatalogService().getMerchantAccountByKey(key);
}

function getMerchantAccountCatalogState() {
  return getRuntimeCatalogService().getState();
}

function refreshMerchantAccounts() {
  return getRuntimeCatalogService().refresh();
}

module.exports = {
  configureCatalogService,
  getMerchantAccounts,
  getPublicMerchantAccounts,
  getMerchantAccountByKey,
  getMerchantAccountCatalogState,
  refreshMerchantAccounts,
  validateMerchantAccounts,
};
