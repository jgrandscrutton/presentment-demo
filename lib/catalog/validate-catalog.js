'use strict';

const ALLOWED_PAYMENT_TYPES = new Set(['one_time', 'recurring']);
const REQUIRED_FIELDS = [
  'key',
  'label',
  'merchantAccountId',
  'currency',
  'paymentTypes',
  'purpose',
  'environment',
  'status',
  'isDefault',
];

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function validateMerchantAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError('Merchant account catalog must be a non-empty array');
  }

  const keys = new Set();
  const merchantAccountIds = new Set();
  const activeRoutes = new Set();
  let defaultCount = 0;
  let defaultAccount = null;

  accounts.forEach((account, index) => {
    const fieldPath = `Merchant account at index ${index}`;

    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw new TypeError(`${fieldPath} must be an object`);
    }

    for (const field of REQUIRED_FIELDS) {
      if (!Object.hasOwn(account, field)) {
        throw new TypeError(`${fieldPath} is missing required field "${field}"`);
      }
    }

    assertNonEmptyString(account.key, `${fieldPath}.key`);
    if (keys.has(account.key)) {
      throw new TypeError(`Duplicate merchant account key "${account.key}"`);
    }
    keys.add(account.key);

    assertNonEmptyString(account.merchantAccountId, `${fieldPath}.merchantAccountId`);
    if (merchantAccountIds.has(account.merchantAccountId)) {
      throw new TypeError(`Duplicate merchant account ID "${account.merchantAccountId}"`);
    }
    merchantAccountIds.add(account.merchantAccountId);

    assertNonEmptyString(account.label, `${fieldPath}.label`);
    assertNonEmptyString(account.purpose, `${fieldPath}.purpose`);
    assertNonEmptyString(account.status, `${fieldPath}.status`);

    if (typeof account.currency !== 'string' || !/^[A-Z]{3}$/.test(account.currency)) {
      throw new TypeError(
        `${fieldPath}.currency must be a three-letter uppercase currency code`
      );
    }

    if (!Array.isArray(account.paymentTypes)) {
      throw new TypeError(`${fieldPath}.paymentTypes must be an array`);
    }

    const paymentTypes = new Set();
    for (const paymentType of account.paymentTypes) {
      if (!ALLOWED_PAYMENT_TYPES.has(paymentType)) {
        throw new TypeError(
          `${fieldPath}.paymentTypes contains unsupported type "${paymentType}"`
        );
      }
      if (paymentTypes.has(paymentType)) {
        throw new TypeError(
          `${fieldPath}.paymentTypes contains duplicate type "${paymentType}"`
        );
      }
      paymentTypes.add(paymentType);

      if (account.status === 'active') {
        const route = `${account.currency}:${paymentType}`;
        if (activeRoutes.has(route)) {
          throw new TypeError(`Duplicate active routing target "${route}"`);
        }
        activeRoutes.add(route);
      }
    }

    if (account.environment !== 'sandbox') {
      throw new TypeError(`${fieldPath}.environment must be "sandbox"`);
    }

    if (typeof account.isDefault !== 'boolean') {
      throw new TypeError(`${fieldPath}.isDefault must be a boolean`);
    }

    if (account.isDefault) {
      defaultCount += 1;
      defaultAccount = account;
    }
  });

  if (defaultCount !== 1) {
    throw new TypeError('Merchant account catalog must contain exactly one default account');
  }
  if (defaultAccount.status !== 'active') {
    throw new TypeError('Merchant account catalog default account must be active');
  }

  return true;
}

module.exports = {
  ALLOWED_PAYMENT_TYPES,
  validateMerchantAccounts,
};
