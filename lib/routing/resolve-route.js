'use strict';

const ALLOWED_PAYMENT_TYPES = new Set(['one_time', 'recurring']);

function normalizeCurrency(currency) {
  return typeof currency === 'string' ? currency.trim().toUpperCase() : null;
}

function normalizePaymentType(paymentType) {
  if (typeof paymentType !== 'string') {
    return null;
  }

  return paymentType.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function describePaymentType(paymentType) {
  return paymentType === 'one_time' ? 'one-time' : paymentType;
}

function validateIntent(intent) {
  const source = intent && typeof intent === 'object' && !Array.isArray(intent)
    ? intent
    : {};
  const normalized = {
    currency: normalizeCurrency(source.currency),
    paymentType: normalizePaymentType(source.paymentType),
  };
  const errors = [];

  if (!normalized.currency || !/^[A-Z]{3}$/.test(normalized.currency)) {
    errors.push('currency must be a three-letter currency code');
  }

  if (!normalized.paymentType || !ALLOWED_PAYMENT_TYPES.has(normalized.paymentType)) {
    errors.push('paymentType must be "one_time" or "recurring"');
  }

  return { normalized, errors };
}

function copyAccount(account) {
  return {
    ...account,
    paymentTypes: Array.isArray(account.paymentTypes) ? [...account.paymentTypes] : [],
    ...(account.paymentTypeSources
      ? { paymentTypeSources: { ...account.paymentTypeSources } }
      : {}),
    ...(account.routingReasons
      ? { routingReasons: { ...account.routingReasons } }
      : {}),
  };
}

function traceAccountId(account, index) {
  if (account && typeof account.merchantAccountId === 'string' && account.merchantAccountId) {
    return account.merchantAccountId;
  }

  return `catalog-entry-${index + 1}`;
}

function invalidIntentTrace(accounts, reason) {
  return accounts.map((account, index) => ({
    account: traceAccountId(account, index),
    result: 'skipped',
    why: reason,
  }));
}

/**
 * Resolve a payment intent to a server-owned Braintree merchant account.
 *
 * Only currency and paymentType are read from intent. In particular, a caller
 * cannot influence routing by including merchantAccountId or another account
 * selector in the object.
 *
 * @param {object} intent
 * @param {Array<object>} catalog Built from the current gateway discovery.
 * @returns {{matched: boolean, intent: object, account: object|null, reason: string, trace: Array<object>}}
 */
function resolveRoute(intent, catalog) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('Routing catalog must be an array');
  }

  const { normalized, errors } = validateIntent(intent);

  if (errors.length > 0) {
    const reason = `Invalid routing intent: ${errors.join('; ')}.`;
    return {
      matched: false,
      intent: normalized,
      account: null,
      reason,
      trace: invalidIntentTrace(catalog, reason),
    };
  }

  let matchedAccount = null;
  const trace = catalog.map((account, index) => {
    const accountId = traceAccountId(account, index);

    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      return {
        account: accountId,
        result: 'skipped',
        why: 'catalog entry is invalid',
      };
    }

    if (account.status !== 'active') {
      return {
        account: accountId,
        result: 'skipped',
        why: `account is not active (status: ${account.status || 'unknown'})`,
      };
    }

    if (account.currency !== normalized.currency) {
      return {
        account: accountId,
        result: 'skipped',
        why: `currency ${account.currency || 'unknown'} \u2260 ${normalized.currency}`,
      };
    }

    if (!Array.isArray(account.paymentTypes) || !account.paymentTypes.includes(normalized.paymentType)) {
      const configuredTypes = Array.isArray(account.paymentTypes)
        ? account.paymentTypes.map(describePaymentType).join(' and ') || 'no payment types'
        : 'no payment types';
      return {
        account: accountId,
        result: 'skipped',
        why: `${account.assignmentState === 'available_not_assigned' ? 'available but not assigned' : `assigned for ${configuredTypes}, not ${describePaymentType(normalized.paymentType)}`}`,
      };
    }

    if (matchedAccount) {
      return {
        account: accountId,
        result: 'skipped',
        why: `route already matched ${matchedAccount.merchantAccountId}`,
      };
    }

    matchedAccount = account;
    return {
      account: accountId,
      result: 'matched',
      why:
        account.routingReasons?.[normalized.paymentType] ||
        `Matched by merchant policy: ${normalized.currency} + ${describePaymentType(normalized.paymentType)}`,
    };
  });

  if (!matchedAccount) {
    return {
      matched: false,
      intent: normalized,
      account: null,
      reason: `No active merchant account is configured for ${normalized.currency} ${describePaymentType(normalized.paymentType)} payments.`,
      trace,
    };
  }

  return {
    matched: true,
    intent: normalized,
    account: copyAccount(matchedAccount),
    reason:
      matchedAccount.routingReasons?.[normalized.paymentType] ||
      `The merchant policy assigns ${normalized.currency} ${describePaymentType(normalized.paymentType)} payments to ${matchedAccount.merchantAccountId}.`,
    trace,
  };
}

module.exports = {
  resolveRoute,
};
