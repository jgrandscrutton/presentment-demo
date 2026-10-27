'use strict';

const { deepFreeze, frozenCopy } = require('./copies');
const { warning } = require('./policy');
const {
  ALLOWED_PAYMENT_TYPES,
  validateMerchantAccounts,
} = require('./validate-catalog');

const PAYMENT_TYPES = Object.freeze(['one_time', 'recurring']);

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareAccounts(left, right) {
  return (
    compareStrings(left.currency, right.currency) ||
    compareStrings(left.merchantAccountId, right.merchantAccountId)
  );
}

function normalizeOverlayEntry(entry, merchantAccountId, warnings) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    warnings.push(
      warning(
        'POLICY_ENTRY_INVALID',
        `The routing policy entry for ${merchantAccountId} is invalid and was ignored.`
      )
    );
    return null;
  }

  const normalized = {
    label:
      typeof entry.label === 'string' && entry.label.trim() !== ''
        ? entry.label.trim()
        : null,
    paymentTypes: [],
  };

  if (!Array.isArray(entry.paymentTypes)) {
    warnings.push(
      warning(
        'POLICY_PAYMENT_TYPES_INVALID',
        `The routing policy payment types for ${merchantAccountId} are invalid and were ignored.`
      )
    );
    return null;
  }

  for (const paymentType of entry.paymentTypes) {
    if (!ALLOWED_PAYMENT_TYPES.has(paymentType)) {
      warnings.push(
        warning(
          'POLICY_PAYMENT_TYPE_UNSUPPORTED',
          `The routing policy for ${merchantAccountId} contains unsupported payment type ${String(paymentType)} and was ignored.`
        )
      );
      return null;
    }
    if (!normalized.paymentTypes.includes(paymentType)) {
      normalized.paymentTypes.push(paymentType);
    }
  }

  return normalized;
}

function preparePolicy({ merchantId, discoveredAccounts, policy, inheritedWarnings }) {
  const warnings = inheritedWarnings.map((item) =>
    warning(
      typeof item?.code === 'string' ? item.code : 'POLICY_WARNING',
      typeof item?.message === 'string'
        ? item.message
        : 'The routing policy reported a warning.'
    )
  );

  if (!policy) {
    return { entries: new Map(), warnings, policyStatus: 'none' };
  }

  if (policy.merchantId !== merchantId) {
    warnings.push(
      warning(
        'POLICY_MERCHANT_ID_MISMATCH',
        `The routing policy does not match connected gateway ${merchantId}; the whole policy was ignored.`
      )
    );
    return { entries: new Map(), warnings, policyStatus: 'ignored' };
  }

  if (!policy.accounts || typeof policy.accounts !== 'object' || Array.isArray(policy.accounts)) {
    warnings.push(
      warning(
        'POLICY_INVALID',
        `The routing policy for gateway ${merchantId} has no valid accounts map; automatic assignment is active.`
      )
    );
    return { entries: new Map(), warnings, policyStatus: 'rejected' };
  }

  const byId = new Map(
    discoveredAccounts.map((account) => [account.merchantAccountId, account])
  );
  const entries = new Map();

  for (const [merchantAccountId, rawEntry] of Object.entries(policy.accounts)) {
    const discovered = byId.get(merchantAccountId);
    if (!discovered) {
      warnings.push(
        warning(
          'POLICY_ACCOUNT_NOT_FOUND',
          `Routing policy account ${merchantAccountId} is not present in gateway ${merchantId} and was ignored.`
        )
      );
      continue;
    }

    const normalized = normalizeOverlayEntry(rawEntry, merchantAccountId, warnings);
    if (!normalized) continue;

    if (discovered.status !== 'active' && normalized.paymentTypes.length > 0) {
      warnings.push(
        warning(
          'POLICY_ACCOUNT_INACTIVE',
          `Routing roles for inactive account ${merchantAccountId} were ignored.`
        )
      );
      normalized.paymentTypes = [];
    }
    entries.set(merchantAccountId, normalized);
  }

  const claimedRoutes = new Map();
  for (const [merchantAccountId, entry] of entries) {
    const account = byId.get(merchantAccountId);
    if (account.status !== 'active') continue;

    for (const paymentType of entry.paymentTypes) {
      const route = `${account.currency}:${paymentType}`;
      const previous = claimedRoutes.get(route);
      if (previous && previous !== merchantAccountId) {
        warnings.push(
          warning(
            'POLICY_DUPLICATE_ROUTE',
            `The routing policy assigns ${route} to both ${previous} and ${merchantAccountId}; the whole policy was rejected.`
          )
        );
        return { entries: new Map(), warnings, policyStatus: 'rejected' };
      }
      claimedRoutes.set(route, merchantAccountId);
    }
  }

  return { entries, warnings, policyStatus: 'applied' };
}

function autoReason(currency, activeAccounts, primary) {
  if (activeAccounts.length === 1) {
    return `Matched automatically (only active ${currency} account)`;
  }
  if (primary.isDefault) {
    return `Matched automatically (gateway default for ${currency})`;
  }
  return `Matched automatically (first active ${currency} account by merchant account ID)`;
}

function finalizeAccount(account) {
  const sourceValues = [...new Set(Object.values(account.paymentTypeSources))];
  const roleSource = sourceValues.length === 0
    ? null
    : sourceValues.length === 1
      ? sourceValues[0]
      : 'mixed';
  const assignmentState = account.status !== 'active'
    ? 'inactive'
    : account.paymentTypes.length > 0
      ? 'assigned'
      : 'available_not_assigned';

  let purpose;
  if (assignmentState === 'inactive') {
    purpose = `Not eligible for routing because its gateway status is ${account.status}.`;
  } else if (assignmentState === 'available_not_assigned') {
    purpose = 'Available, not assigned. Assign it through the merchant policy overlay.';
  } else if (roleSource === 'policy') {
    purpose = 'Payment roles assigned by the merchant policy overlay.';
  } else if (roleSource === 'auto') {
    purpose = 'Payment roles assigned automatically from the discovered gateway accounts.';
  } else {
    purpose = 'Payment roles assigned by both merchant policy and automatic assignment.';
  }

  return {
    ...account,
    roleSource,
    assignmentState,
    purpose,
  };
}

function buildMerchantAccountCatalog({
  merchantId,
  discoveredAccounts,
  policy = null,
  warnings: inheritedWarnings = [],
} = {}) {
  if (typeof merchantId !== 'string' || merchantId.trim() === '') {
    throw new TypeError('A gateway merchant ID is required to build the catalog');
  }
  if (!Array.isArray(discoveredAccounts) || discoveredAccounts.length === 0) {
    throw new TypeError('At least one discovered merchant account is required');
  }

  const defaults = discoveredAccounts.filter((account) => account.isDefault === true);
  if (defaults.length !== 1) {
    throw new TypeError(
      `Merchant account discovery must return exactly one default account; received ${defaults.length}`
    );
  }
  if (defaults[0].status !== 'active') {
    throw new TypeError(
      `Merchant account discovery default account ${defaults[0].merchantAccountId} must be active`
    );
  }

  const prepared = preparePolicy({
    merchantId: merchantId.trim(),
    discoveredAccounts,
    policy,
    inheritedWarnings,
  });

  const working = discoveredAccounts.map((discovered) => {
    const overlay = prepared.entries.get(discovered.merchantAccountId);
    const paymentTypes = [];
    const paymentTypeSources = {};
    const routingReasons = {};

    if (discovered.status === 'active' && overlay) {
      for (const paymentType of overlay.paymentTypes) {
        paymentTypes.push(paymentType);
        paymentTypeSources[paymentType] = 'policy';
        routingReasons[paymentType] = 'Matched by merchant policy';
      }
    }

    return {
      key: discovered.merchantAccountId,
      label: overlay?.label || `${discovered.currency} account (${discovered.merchantAccountId})`,
      merchantAccountId: discovered.merchantAccountId,
      currency: discovered.currency,
      paymentTypes,
      paymentTypeSources,
      routingReasons,
      environment: 'sandbox',
      status: discovered.status,
      isDefault: discovered.isDefault,
    };
  });

  const currencies = [...new Set(working.map((account) => account.currency))].sort();
  for (const currency of currencies) {
    const activeAccounts = working
      .filter((account) => account.currency === currency && account.status === 'active')
      .sort((left, right) =>
        compareStrings(left.merchantAccountId, right.merchantAccountId)
      );
    if (activeAccounts.length === 0) continue;

    const autoCandidates = activeAccounts.filter(
      (account) => !prepared.entries.has(account.merchantAccountId)
    );
    if (autoCandidates.length === 0) continue;

    const primary =
      autoCandidates.find((account) => account.isDefault) || autoCandidates[0];
    const reason = autoReason(currency, activeAccounts, primary);

    for (const paymentType of PAYMENT_TYPES) {
      const alreadyClaimed = activeAccounts.some((account) =>
        account.paymentTypes.includes(paymentType)
      );
      if (alreadyClaimed) continue;

      primary.paymentTypes.push(paymentType);
      primary.paymentTypeSources[paymentType] = 'auto';
      primary.routingReasons[paymentType] = reason;
    }
  }

  const accounts = working.map(finalizeAccount).sort(compareAccounts);
  validateMerchantAccounts(accounts);

  return deepFreeze({
    accounts,
    warnings: prepared.warnings,
    policyStatus: prepared.policyStatus,
  });
}

function copyBuiltCatalog(catalog) {
  return frozenCopy(catalog);
}

module.exports = {
  PAYMENT_TYPES,
  buildMerchantAccountCatalog,
  copyBuiltCatalog,
};
