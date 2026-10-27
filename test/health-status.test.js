'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthStatusFor } = require('../app');

function catalogService(state) {
  const calls = { getState: 0, refresh: 0 };

  return {
    calls,
    getState() {
      calls.getState += 1;
      return structuredClone(state);
    },
    refresh() {
      calls.refresh += 1;
      throw new Error('health checks must never start merchant-account discovery');
    },
  };
}

test('health reports an available discovered catalog without making a gateway call', () => {
  const service = catalogService({
    status: 'ok',
    gatewayMerchantId: 'dynamic-gateway',
    discoveredAt: '2026-10-15T11:00:00.000Z',
    accounts: [
      { merchantAccountId: 'cad-active', currency: 'CAD', status: 'active' },
      { merchantAccountId: 'jpy-active', currency: 'JPY', status: 'active' },
      { merchantAccountId: 'jpy-inactive', currency: 'JPY', status: 'suspended' },
    ],
  });

  assert.deepEqual(buildHealthStatusFor(service), {
    status: 'up',
    environment: 'sandbox',
    checks: {
      server: 'up',
      merchantAccountDiscovery: 'ok',
      braintreeConnectivity: 'not_checked',
    },
    gatewayMerchantId: 'dynamic-gateway',
    discoveredAt: '2026-10-15T11:00:00.000Z',
    configuredMerchantAccounts: 3,
    activeMerchantAccounts: 2,
    currencies: ['CAD', 'JPY'],
  });
  assert.deepEqual(service.calls, { getState: 1, refresh: 0 });
});

test('health reports failed discovery without exposing a stale catalog or retrying discovery', () => {
  const service = catalogService({
    status: 'failed',
    gatewayMerchantId: 'dynamic-gateway',
    discoveredAt: null,
    error: {
      code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED',
      message: 'Safe failure message.',
    },
    accounts: [
      { merchantAccountId: 'stale-account', currency: 'CAD', status: 'active' },
    ],
  });

  const health = buildHealthStatusFor(service);

  assert.equal(health.checks.merchantAccountDiscovery, 'failed');
  assert.equal(health.checks.braintreeConnectivity, 'not_checked');
  assert.equal(health.gatewayMerchantId, 'dynamic-gateway');
  assert.equal(health.discoveredAt, null);
  assert.equal(health.configuredMerchantAccounts, 0);
  assert.equal(health.activeMerchantAccounts, 0);
  assert.deepEqual(health.currencies, []);
  assert.deepEqual(service.calls, { getState: 1, refresh: 0 });
});

test('health reports discovery not_run without triggering initialization', () => {
  const service = catalogService({
    status: 'not_run',
    gatewayMerchantId: null,
    discoveredAt: null,
    error: null,
    accounts: [],
  });

  const health = buildHealthStatusFor(service);

  assert.equal(health.status, 'up');
  assert.equal(health.checks.server, 'up');
  assert.equal(health.checks.merchantAccountDiscovery, 'not_run');
  assert.equal(health.checks.braintreeConnectivity, 'not_checked');
  assert.equal(health.gatewayMerchantId, null);
  assert.equal(health.discoveredAt, null);
  assert.equal(health.configuredMerchantAccounts, 0);
  assert.deepEqual(health.currencies, []);
  assert.deepEqual(service.calls, { getState: 1, refresh: 0 });
});
