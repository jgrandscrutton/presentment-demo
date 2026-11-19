'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  PolicyUpdateError,
  buildRoutingPolicy,
  createPolicyWriter,
} = require('../lib/catalog/policy-writer');

function account(id, currency, options = {}) {
  return {
    merchantAccountId: id,
    label: `${currency} ${id}`,
    currency,
    status: options.status || 'active',
    isDefault: options.isDefault === true,
    paymentMethods: options.status === 'suspended' ? [] : ['card', 'paypal'],
    threeDSecurePolicy: options.policy || 'optional',
  };
}

const merchantId = 'fixture-merchant';
const accounts = [
  account('eur', 'EUR', { policy: 'required' }),
  account('gbp', 'GBP', { isDefault: true }),
  account('usd-one', 'USD'),
  account('usd-recurring', 'USD'),
  account('inactive-usd', 'USD', { status: 'suspended' }),
];

function fullAssignments(overrides = {}) {
  const defaults = {
    'EUR:one_time': 'eur',
    'EUR:recurring': 'eur',
    'GBP:one_time': 'gbp',
    'GBP:recurring': 'gbp',
    'USD:one_time': 'usd-one',
    'USD:recurring': 'usd-recurring',
    ...overrides,
  };
  return Object.entries(defaults).map(([route, merchantAccountId]) => {
    const [currency, paymentType] = route.split(':');
    return { currency, paymentType, merchantAccountId };
  });
}

function refreshedState(policy, overrides = {}) {
  return {
    status: 'ok',
    gatewayMerchantId: merchantId,
    policyStatus: 'applied',
    accounts: accounts.map((current) => ({
      ...current,
      paymentTypes: [...(policy.accounts[current.merchantAccountId]?.paymentTypes || [])],
    })),
    ...overrides,
  };
}

test('buildRoutingPolicy preserves capabilities and changes only complete valid routes', () => {
  const policy = buildRoutingPolicy({
    merchantId,
    accounts,
    assignments: fullAssignments({
      'USD:one_time': 'usd-recurring',
      'USD:recurring': 'usd-one',
    }),
  });

  assert.deepEqual(policy.accounts['usd-one'].paymentTypes, ['recurring']);
  assert.deepEqual(policy.accounts['usd-recurring'].paymentTypes, ['one_time']);
  assert.deepEqual(policy.accounts['usd-one'].paymentMethods, ['card', 'paypal']);
  assert.equal(policy.accounts.eur.threeDSecurePolicy, 'required');
  assert.deepEqual(policy.accounts['inactive-usd'].paymentTypes, []);
  assert.deepEqual(policy.accounts['inactive-usd'].paymentMethods, []);
});

test('buildRoutingPolicy rejects missing routes, unknown accounts, and cross-currency assignments', () => {
  assert.throws(
    () => buildRoutingPolicy({
      merchantId,
      accounts,
      assignments: fullAssignments().slice(1),
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'POLICY_ASSIGNMENT_INVALID'
  );
  assert.throws(
    () => buildRoutingPolicy({
      merchantId,
      accounts,
      assignments: fullAssignments({ 'USD:one_time': 'not-discovered' }),
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'POLICY_ACCOUNT_INVALID'
  );
  assert.throws(
    () => buildRoutingPolicy({
      merchantId,
      accounts,
      assignments: fullAssignments({ 'USD:one_time': 'gbp' }),
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'POLICY_ACCOUNT_INVALID'
  );
});

test('buildRoutingPolicy fails closed for malformed account capabilities', () => {
  assert.throws(
    () => buildRoutingPolicy({
      merchantId,
      accounts: accounts.map((current) =>
        current.merchantAccountId === 'eur'
          ? { ...current, threeDSecurePolicy: 'disabled' }
          : current
      ),
      assignments: fullAssignments(),
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'CATALOG_INVALID'
  );
  assert.throws(
    () => buildRoutingPolicy({
      merchantId,
      accounts: accounts.map((current) =>
        current.merchantAccountId === 'usd-one'
          ? { ...current, paymentMethods: ['paypal'] }
          : current
      ),
      assignments: fullAssignments(),
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'CATALOG_INVALID'
  );
});

test('writer captures the original overlay once and restores it after presenter edits', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phonepal-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, `${merchantId}.json`);
  const original = '{"merchantId":"fixture-merchant","accounts":{}}\n';
  await fs.writeFile(policyPath, original, { mode: 0o600 });
  const writer = createPolicyWriter({ policiesDirectory: directory });
  const refreshed = [];
  const refresh = async () => {
    const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
    refreshed.push(policy);
    return refreshedState(policy);
  };

  assert.equal(await writer.hasBaseline({ merchantId }), false);
  await writer.save({ merchantId, accounts, assignments: fullAssignments(), refresh });
  assert.equal(await writer.hasBaseline({ merchantId }), true);
  assert.equal(
    (await fs.stat(path.join(directory, `${merchantId}.presenter-baseline.json`))).mode & 0o777,
    0o600
  );
  const saved = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  assert.deepEqual(saved.accounts['usd-one'].paymentTypes, ['one_time']);
  assert.equal((await fs.stat(policyPath)).mode & 0o777, 0o600);

  await writer.save({
    merchantId,
    accounts,
    assignments: fullAssignments({
      'USD:one_time': 'usd-recurring',
      'USD:recurring': 'usd-one',
    }),
    refresh,
  });
  await writer.restore({ merchantId, refresh });
  assert.equal(await fs.readFile(policyPath, 'utf8'), original);
  assert.equal(refreshed.length, 3);
});

test('writer rolls the overlay back when refreshed discovery rejects a change', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phonepal-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, `${merchantId}.json`);
  const original = '{"merchantId":"fixture-merchant","accounts":{}}\n';
  await fs.writeFile(policyPath, original, { mode: 0o600 });
  const writer = createPolicyWriter({ policiesDirectory: directory });
  let refreshCount = 0;

  await assert.rejects(
    writer.save({
      merchantId,
      accounts,
      assignments: fullAssignments(),
      refresh: async () => {
        refreshCount += 1;
        return refreshCount === 1
          ? { status: 'failed', policyStatus: 'rejected' }
          : { status: 'ok', policyStatus: 'applied' };
      },
    }),
    (error) => error instanceof PolicyUpdateError && error.code === 'CATALOG_REFRESH_FAILED'
  );

  assert.equal(await fs.readFile(policyPath, 'utf8'), original);
  assert.equal(refreshCount, 2);
});

test('writer rolls back when applied discovery drops a requested route', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phonepal-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, `${merchantId}.json`);
  const original = '{"merchantId":"fixture-merchant","accounts":{}}\n';
  await fs.writeFile(policyPath, original, { mode: 0o600 });
  const writer = createPolicyWriter({ policiesDirectory: directory });
  let refreshCount = 0;

  await assert.rejects(
    writer.save({
      merchantId,
      accounts,
      assignments: fullAssignments(),
      refresh: async () => {
        refreshCount += 1;
        if (refreshCount > 1) {
          return { status: 'ok', policyStatus: 'applied' };
        }
        const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
        const state = refreshedState(policy);
        state.accounts.find(
          (current) => current.merchantAccountId === 'usd-one'
        ).paymentTypes = [];
        return state;
      },
    }),
    (error) =>
      error instanceof PolicyUpdateError &&
      error.code === 'CATALOG_CHANGED_DURING_UPDATE'
  );

  assert.equal(await fs.readFile(policyPath, 'utf8'), original);
  assert.equal(refreshCount, 2);
});

test('writer reports a distinct hard failure when automatic rollback cannot restore the file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phonepal-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, `${merchantId}.json`);
  const original = '{"merchantId":"fixture-merchant","accounts":{}}\n';
  await fs.writeFile(policyPath, original, { mode: 0o600 });
  const writer = createPolicyWriter({
    policiesDirectory: directory,
    fileOperations: {
      replaceOptional: async () => {
        throw new Error('simulated rollback failure');
      },
    },
  });

  await assert.rejects(
    writer.save({
      merchantId,
      accounts,
      assignments: fullAssignments(),
      refresh: async () => ({ status: 'failed', policyStatus: 'rejected' }),
    }),
    (error) =>
      error instanceof PolicyUpdateError &&
      error.code === 'POLICY_ROLLBACK_FAILED' &&
      error.cause instanceof AggregateError
  );

  assert.notEqual(await fs.readFile(policyPath, 'utf8'), original);
});
