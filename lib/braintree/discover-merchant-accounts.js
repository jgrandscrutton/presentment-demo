'use strict';

class MerchantAccountDiscoveryError extends Error {
  constructor(message, { code = 'MERCHANT_ACCOUNT_DISCOVERY_FAILED', cause } = {}) {
    super(message, { cause });
    this.name = 'MerchantAccountDiscoveryError';
    this.code = code;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MerchantAccountDiscoveryError(
      `Braintree returned a merchant account without ${fieldName}.`,
      { code: 'INVALID_DISCOVERY_RESULT' }
    );
  }

  return value.trim();
}

function normalizeMerchantAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new MerchantAccountDiscoveryError(
      'Braintree returned an invalid merchant account.',
      { code: 'INVALID_DISCOVERY_RESULT' }
    );
  }

  const merchantAccountId = requireNonEmptyString(account.id, 'an ID');
  const currency = requireNonEmptyString(
    account.currencyIsoCode,
    'a currency'
  ).toUpperCase();
  const status = requireNonEmptyString(account.status, 'a status').toLowerCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MerchantAccountDiscoveryError(
      `Braintree returned an invalid currency for merchant account ${merchantAccountId}.`,
      { code: 'INVALID_DISCOVERY_RESULT' }
    );
  }

  return Object.freeze({
    merchantAccountId,
    currency,
    status,
    isDefault: account.default === true || account.isDefault === true,
  });
}

function listAllMerchantAccounts(gateway) {
  if (!gateway?.merchantAccount?.all) {
    return Promise.reject(
      new TypeError('A Braintree gateway with the merchantAccount API is required')
    );
  }

  // The SDK's callback form collects every page before invoking this callback.
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error, accounts) => {
      if (settled) return;
      settled = true;

      if (error) {
        reject(
          new MerchantAccountDiscoveryError(
            'Unable to load merchant accounts from Braintree Sandbox.',
            { cause: error }
          )
        );
        return;
      }

      resolve(accounts);
    };

    try {
      gateway.merchantAccount.all(finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function discoverMerchantAccounts(gateway) {
  const rawAccounts = await listAllMerchantAccounts(gateway);

  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    throw new MerchantAccountDiscoveryError(
      'Braintree Sandbox did not return any merchant accounts.',
      { code: 'EMPTY_DISCOVERY_RESULT' }
    );
  }

  const accounts = rawAccounts.map(normalizeMerchantAccount);
  const ids = new Set();

  for (const account of accounts) {
    if (ids.has(account.merchantAccountId)) {
      throw new MerchantAccountDiscoveryError(
        `Braintree returned merchant account ${account.merchantAccountId} more than once.`,
        { code: 'INVALID_DISCOVERY_RESULT' }
      );
    }
    ids.add(account.merchantAccountId);
  }

  return Object.freeze([...accounts]);
}

module.exports = {
  MerchantAccountDiscoveryError,
  discoverMerchantAccounts,
  listAllMerchantAccounts,
  normalizeMerchantAccount,
};
