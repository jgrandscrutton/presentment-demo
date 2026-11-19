'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { buildMerchantAccountCatalog, PAYMENT_TYPES } = require('./build-catalog');
const { IMPLEMENTED_PAYMENT_METHODS } = require('../payment-methods');
const {
  DEFAULT_POLICIES_DIRECTORY,
  safePolicyFilename,
} = require('./policy');

const PAYMENT_TYPE_SET = new Set(PAYMENT_TYPES);

class PolicyUpdateError extends Error {
  constructor(message, { code = 'POLICY_UPDATE_FAILED', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PolicyUpdateError';
    this.code = code;
  }
}

function normalizeCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new PolicyUpdateError('Every route assignment needs a valid currency.', {
      code: 'POLICY_ASSIGNMENT_INVALID',
    });
  }
  return value.trim().toUpperCase();
}

function discoveredAccountCopy(account) {
  return {
    merchantAccountId: account.merchantAccountId,
    currency: account.currency,
    status: account.status,
    isDefault: account.isDefault === true,
  };
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new PolicyUpdateError('A current discovered account catalog is required.', {
      code: 'CATALOG_UNAVAILABLE',
    });
  }

  const ids = new Set();
  for (const account of accounts) {
    if (
      !account ||
      typeof account !== 'object' ||
      typeof account.merchantAccountId !== 'string' ||
      account.merchantAccountId.trim() === '' ||
      typeof account.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(account.currency) ||
      !['active', 'suspended'].includes(account.status)
    ) {
      throw new PolicyUpdateError('The current account catalog is not safe to edit.', {
        code: 'CATALOG_INVALID',
      });
    }
    if (!['required', 'optional'].includes(account.threeDSecurePolicy)) {
      throw new PolicyUpdateError(
        'The current account catalog has an invalid 3D Secure policy.',
        { code: 'CATALOG_INVALID' }
      );
    }
    if (!Array.isArray(account.paymentMethods)) {
      throw new PolicyUpdateError(
        'The current account catalog has invalid payment-method capabilities.',
        { code: 'CATALOG_INVALID' }
      );
    }
    const paymentMethods = new Set();
    for (const paymentMethod of account.paymentMethods) {
      if (
        !IMPLEMENTED_PAYMENT_METHODS.has(paymentMethod) ||
        paymentMethods.has(paymentMethod)
      ) {
        throw new PolicyUpdateError(
          'The current account catalog has invalid payment-method capabilities.',
          { code: 'CATALOG_INVALID' }
        );
      }
      paymentMethods.add(paymentMethod);
    }
    if (
      (account.status === 'active' && !paymentMethods.has('card')) ||
      (account.status !== 'active' && paymentMethods.size > 0)
    ) {
      throw new PolicyUpdateError(
        'The current account catalog has unsafe payment-method capabilities.',
        { code: 'CATALOG_INVALID' }
      );
    }
    if (ids.has(account.merchantAccountId)) {
      throw new PolicyUpdateError('The current account catalog contains duplicate IDs.', {
        code: 'CATALOG_INVALID',
      });
    }
    ids.add(account.merchantAccountId);
  }
}

function buildRoutingPolicy({ merchantId, accounts, assignments } = {}) {
  safePolicyFilename(merchantId);
  validateAccounts(accounts);
  if (!Array.isArray(assignments)) {
    throw new PolicyUpdateError('Route assignments must be submitted as a list.', {
      code: 'POLICY_ASSIGNMENT_INVALID',
    });
  }

  const activeAccounts = accounts.filter((account) => account.status === 'active');
  const activeById = new Map(
    activeAccounts.map((account) => [account.merchantAccountId, account])
  );
  const currencies = [...new Set(activeAccounts.map((account) => account.currency))].sort();
  const expectedRoutes = new Set(
    currencies.flatMap((currency) =>
      PAYMENT_TYPES.map((paymentType) => `${currency}:${paymentType}`)
    )
  );
  const selectedByRoute = new Map();

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new PolicyUpdateError('A route assignment is malformed.', {
        code: 'POLICY_ASSIGNMENT_INVALID',
      });
    }
    const currency = normalizeCurrency(assignment.currency);
    const paymentType = assignment.paymentType;
    if (!PAYMENT_TYPE_SET.has(paymentType)) {
      throw new PolicyUpdateError('A route assignment contains an unsupported payment type.', {
        code: 'POLICY_ASSIGNMENT_INVALID',
      });
    }
    const route = `${currency}:${paymentType}`;
    if (!expectedRoutes.has(route) || selectedByRoute.has(route)) {
      throw new PolicyUpdateError('Route assignments must cover each discovered route once.', {
        code: 'POLICY_ASSIGNMENT_INVALID',
      });
    }

    const rawAccountId = assignment.merchantAccountId;
    const merchantAccountId = rawAccountId == null || rawAccountId === ''
      ? null
      : typeof rawAccountId === 'string'
        ? rawAccountId.trim()
        : null;
    if (rawAccountId != null && rawAccountId !== '' && !merchantAccountId) {
      throw new PolicyUpdateError('A route assignment contains an invalid account ID.', {
        code: 'POLICY_ASSIGNMENT_INVALID',
      });
    }
    if (merchantAccountId) {
      const account = activeById.get(merchantAccountId);
      if (!account || account.currency !== currency) {
        throw new PolicyUpdateError(
          'A route can only use an active account discovered for the same currency.',
          { code: 'POLICY_ACCOUNT_INVALID' }
        );
      }
    }
    selectedByRoute.set(route, merchantAccountId);
  }

  if (selectedByRoute.size !== expectedRoutes.size) {
    throw new PolicyUpdateError('Route assignments are incomplete.', {
      code: 'POLICY_ASSIGNMENT_INVALID',
    });
  }

  const policyAccounts = {};
  for (const account of accounts) {
    const paymentTypes = PAYMENT_TYPES.filter(
      (paymentType) =>
        selectedByRoute.get(`${account.currency}:${paymentType}`) ===
        account.merchantAccountId
    );
    policyAccounts[account.merchantAccountId] = {
      label:
        typeof account.label === 'string' && account.label.trim() !== ''
          ? account.label.trim()
          : `${account.currency} account (${account.merchantAccountId})`,
      paymentTypes,
      paymentMethods:
        account.status === 'active' && Array.isArray(account.paymentMethods)
          ? [...account.paymentMethods]
          : [],
      threeDSecurePolicy: account.threeDSecurePolicy,
    };
  }

  const policy = {
    merchantId: merchantId.trim(),
    accounts: policyAccounts,
  };
  const validation = buildMerchantAccountCatalog({
    merchantId: merchantId.trim(),
    discoveredAccounts: accounts.map(discoveredAccountCopy),
    policy,
  });
  if (validation.policyStatus !== 'applied') {
    throw new PolicyUpdateError('The proposed routing policy was rejected.', {
      code: 'POLICY_VALIDATION_FAILED',
    });
  }
  return policy;
}

async function readOptional(filePath) {
  try {
    return { exists: true, contents: await fs.readFile(filePath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, contents: null };
    throw error;
  }
}

async function writeAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function replaceOptional(filePath, snapshot) {
  if (snapshot.exists) {
    await writeAtomically(filePath, snapshot.contents);
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertRefreshResult(state, { allowMissingPolicy = false } = {}) {
  if (!state || state.status !== 'ok') {
    throw new PolicyUpdateError('Catalog refresh failed after the policy change.', {
      code: 'CATALOG_REFRESH_FAILED',
    });
  }
  if (!allowMissingPolicy && state.policyStatus !== 'applied') {
    throw new PolicyUpdateError('The refreshed catalog rejected the policy change.', {
      code: 'POLICY_VALIDATION_FAILED',
    });
  }
  return state;
}

function discoveryFingerprint(accounts) {
  if (!Array.isArray(accounts)) return null;
  return accounts
    .map((account) => ({
      merchantAccountId: account?.merchantAccountId,
      currency: account?.currency,
      status: account?.status,
      isDefault: account?.isDefault === true,
    }))
    .sort((left, right) =>
      String(left.merchantAccountId).localeCompare(String(right.merchantAccountId))
    );
}

function catalogChangedProblem() {
  return new PolicyUpdateError(
    'Merchant accounts changed while the route policy was being saved. Reload the editor before trying again.',
    { code: 'CATALOG_CHANGED_DURING_UPDATE' }
  );
}

function assertRefreshedPolicy(state, { merchantId, accounts, policy }) {
  if (
    state.gatewayMerchantId !== merchantId ||
    JSON.stringify(discoveryFingerprint(state.accounts)) !==
      JSON.stringify(discoveryFingerprint(accounts))
  ) {
    throw catalogChangedProblem();
  }

  const refreshedAccounts = state.accounts;
  const activeCurrencies = [...new Set(
    accounts
      .filter((account) => account.status === 'active')
      .map((account) => account.currency)
  )].sort();
  for (const currency of activeCurrencies) {
    for (const paymentType of PAYMENT_TYPES) {
      const expected = Object.entries(policy.accounts).find(
        ([merchantAccountId, entry]) =>
          accounts.some(
            (account) =>
              account.merchantAccountId === merchantAccountId &&
              account.currency === currency &&
              account.status === 'active'
          ) &&
          entry.paymentTypes.includes(paymentType)
      )?.[0] || null;
      const actualMatches = refreshedAccounts.filter(
        (account) =>
          account.status === 'active' &&
          account.currency === currency &&
          Array.isArray(account.paymentTypes) &&
          account.paymentTypes.includes(paymentType)
      );
      const actual = actualMatches.length === 1
        ? actualMatches[0].merchantAccountId
        : null;
      if (actualMatches.length > 1 || actual !== expected) {
        throw catalogChangedProblem();
      }
    }
  }
  return state;
}

function createPolicyWriter({
  policiesDirectory = DEFAULT_POLICIES_DIRECTORY,
  fileOperations = {},
} = {}) {
  if (typeof policiesDirectory !== 'string' || policiesDirectory.trim() === '') {
    throw new TypeError('A routing policies directory is required');
  }
  if (!fileOperations || typeof fileOperations !== 'object' || Array.isArray(fileOperations)) {
    throw new TypeError('Policy file operations must be an object');
  }
  const replaceForRollback = fileOperations.replaceOptional || replaceOptional;
  if (typeof replaceForRollback !== 'function') {
    throw new TypeError('The rollback file operation must be a function');
  }
  let pending = Promise.resolve();

  function pathsFor(merchantId) {
    const filename = safePolicyFilename(merchantId);
    return {
      policyPath: path.join(policiesDirectory, filename),
      // Keep the presenter baseline beside the ignored local overlay and give it
      // a .json suffix so it is covered by the repository's routing-policy
      // ignore rule. It can contain the connected merchant ID and must never be
      // treated as a source-controlled example policy.
      baselinePath: path.join(
        policiesDirectory,
        `${filename.slice(0, -'.json'.length)}.presenter-baseline.json`
      ),
    };
  }

  function exclusively(operation) {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function ensureBaseline(merchantId, policyPath, baselinePath) {
    const existing = await readOptional(baselinePath);
    if (existing.exists) return;
    const current = await readOptional(policyPath);
    const baseline = {
      version: 1,
      merchantId,
      existed: current.exists,
      contents: current.contents,
    };
    await writeAtomically(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  }

  async function rollback(policyPath, snapshot, refresh) {
    await replaceForRollback(policyPath, snapshot);
    try {
      await refresh();
    } catch {
      // The original file is restored even if the external discovery retry fails.
    }
  }

  async function rollbackAfterFailure({ policyPath, snapshot, refresh, originalError }) {
    try {
      await rollback(policyPath, snapshot, refresh);
    } catch (rollbackError) {
      throw new PolicyUpdateError(
        'The policy change failed and the previous overlay could not be restored automatically. Stop route edits and inspect the local policy file before continuing.',
        {
          code: 'POLICY_ROLLBACK_FAILED',
          cause: new AggregateError(
            [originalError, rollbackError],
            'The policy update and its rollback both failed.'
          ),
        }
      );
    }
  }

  function save({ merchantId, accounts, assignments, refresh } = {}) {
    return exclusively(async () => {
      if (typeof refresh !== 'function') {
        throw new TypeError('A catalog refresh function is required');
      }
      const policy = buildRoutingPolicy({ merchantId, accounts, assignments });
      const { policyPath, baselinePath } = pathsFor(merchantId);
      await ensureBaseline(merchantId.trim(), policyPath, baselinePath);
      const previous = await readOptional(policyPath);
      try {
        await writeAtomically(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
        const state = assertRefreshedPolicy(
          assertRefreshResult(await refresh()),
          { merchantId: merchantId.trim(), accounts, policy }
        );
        return { policy, state };
      } catch (error) {
        await rollbackAfterFailure({
          policyPath,
          snapshot: previous,
          refresh,
          originalError: error,
        });
        if (error instanceof PolicyUpdateError) throw error;
        throw new PolicyUpdateError('The routing policy could not be saved safely.', {
          cause: error,
        });
      }
    });
  }

  function restore({ merchantId, refresh } = {}) {
    return exclusively(async () => {
      if (typeof refresh !== 'function') {
        throw new TypeError('A catalog refresh function is required');
      }
      const { policyPath, baselinePath } = pathsFor(merchantId);
      const baselineFile = await readOptional(baselinePath);
      if (!baselineFile.exists) {
        throw new PolicyUpdateError('No presenter baseline has been captured yet.', {
          code: 'POLICY_BASELINE_NOT_FOUND',
        });
      }
      let baseline;
      try {
        baseline = JSON.parse(baselineFile.contents);
      } catch {
        throw new PolicyUpdateError('The presenter baseline is invalid.', {
          code: 'POLICY_BASELINE_INVALID',
        });
      }
      if (
        baseline?.version !== 1 ||
        baseline.merchantId !== merchantId.trim() ||
        typeof baseline.existed !== 'boolean' ||
        (baseline.existed && typeof baseline.contents !== 'string')
      ) {
        throw new PolicyUpdateError('The presenter baseline does not match this gateway.', {
          code: 'POLICY_BASELINE_INVALID',
        });
      }

      const previous = await readOptional(policyPath);
      try {
        await replaceOptional(policyPath, {
          exists: baseline.existed,
          contents: baseline.contents,
        });
        const state = assertRefreshResult(await refresh(), {
          allowMissingPolicy: !baseline.existed,
        });
        return { state };
      } catch (error) {
        await rollbackAfterFailure({
          policyPath,
          snapshot: previous,
          refresh,
          originalError: error,
        });
        if (error instanceof PolicyUpdateError) throw error;
        throw new PolicyUpdateError('The baseline policy could not be restored safely.', {
          cause: error,
        });
      }
    });
  }

  async function hasBaseline({ merchantId } = {}) {
    const { baselinePath } = pathsFor(merchantId);
    return (await readOptional(baselinePath)).exists;
  }

  return Object.freeze({ hasBaseline, restore, save });
}

module.exports = {
  PolicyUpdateError,
  buildRoutingPolicy,
  createPolicyWriter,
};
