'use strict';

class CatalogUnavailableError extends Error {
  constructor(message = 'The merchant account catalog is unavailable.') {
    super(message);
    this.name = 'CatalogUnavailableError';
    this.code = 'CATALOG_UNAVAILABLE';
  }
}

class MerchantAccountNotFoundError extends Error {
  constructor(merchantAccountId) {
    super(
      `Merchant account ${merchantAccountId} is not active in the current discovered catalog.`
    );
    this.name = 'MerchantAccountNotFoundError';
    this.code = 'UNKNOWN_MERCHANT_ACCOUNT';
    this.merchantAccountId = merchantAccountId;
  }
}

module.exports = {
  CatalogUnavailableError,
  MerchantAccountNotFoundError,
};
