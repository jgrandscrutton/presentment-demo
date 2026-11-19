'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCatalogService,
  PlanCatalogUnavailableError,
  PlanNotFoundError,
  PlanRouteMismatchError,
} = require('../lib/catalog/service');

function discoveredAccount(overrides = {}) {
  return {
    merchantAccountId: 'usd-recurring',
    currency: 'USD',
    status: 'active',
    isDefault: true,
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    id: 'usd-monthly',
    name: 'USD monthly',
    description: 'Monthly subscription',
    currency: 'USD',
    price: '10.00',
    billingFrequency: 1,
    trialPeriod: false,
    trialDuration: null,
    trialDurationUnit: null,
    ...overrides,
  };
}

function makeService(overrides = {}) {
  return createCatalogService({
    gateway: {},
    merchantId: 'plan-fixture',
    discover: async () => [discoveredAccount()],
    discoverPlans: async () => ({ plans: [plan()], warnings: [] }),
    policyLoader: async () => ({ policy: null, warnings: [] }),
    now: () => new Date('2026-10-27T10:00:00.000Z'),
    ...overrides,
  });
}

test('catalogs only routed plans and exposes frozen plan accessors', async () => {
  const service = makeService();
  const state = await service.refresh();

  assert.equal(state.status, 'ok');
  assert.deepEqual(state.planDiscovery, {
    status: 'ok',
    discoveredAt: '2026-10-27T10:00:00.000Z',
    error: null,
  });
  assert.deepEqual(state.plans, [plan()]);

  const allPlans = service.getPlans();
  assert.notStrictEqual(allPlans, service.getPlans());
  assert.ok(Object.isFrozen(allPlans));
  assert.ok(Object.isFrozen(allPlans[0]));
  assert.deepEqual(service.getPlansForCurrency('usd'), [plan()]);
  assert.deepEqual(service.getPlansForCurrency('EUR'), []);
  assert.deepEqual(service.getPlanById('usd-monthly'), plan());
  assert.equal(service.getPlanById('missing-plan'), undefined);
  assert.deepEqual(service.assertPlanForRoute('usd-monthly', 'USD'), plan());
});

test('assertPlanForRoute distinguishes missing plans from currency mismatches', async () => {
  const service = makeService();
  await service.refresh();

  assert.throws(
    () => service.assertPlanForRoute('missing-plan', 'USD'),
    PlanNotFoundError
  );
  assert.throws(
    () => service.assertPlanForRoute('usd-monthly', 'EUR'),
    PlanRouteMismatchError
  );
});

test('malformed and unroutable plans are excluded without failing account routing', async () => {
  const service = makeService({
    discoverPlans: async () => ({
      plans: [
        plan(),
        plan({ id: 'cad-plan', currency: 'CAD' }),
        plan({ id: 'private invalid plan identifier' }),
      ],
      warnings: [],
    }),
  });

  const state = await service.refresh();

  assert.equal(state.status, 'ok');
  assert.equal(state.planDiscovery.status, 'ok');
  assert.deepEqual(state.plans.map((candidate) => candidate.id), ['usd-monthly']);
  assert.ok(state.warnings.some((item) => item.code === 'PLAN_INVALID'));
  assert.ok(
    state.warnings.some((item) => item.code === 'PLAN_CURRENCY_UNROUTABLE')
  );
  assert.equal(
    JSON.stringify(state.warnings).includes('private invalid plan identifier'),
    false
  );
  assert.equal(service.assertMerchantAccountId('usd-recurring'), 'usd-recurring');
});

test('a currency without an active recurring route cannot contribute plans', async () => {
  const service = makeService({
    policyLoader: async () => ({
      policy: {
        merchantId: 'plan-fixture',
        accounts: {
          'usd-recurring': {
            label: 'One-time only',
            paymentTypes: ['one_time'],
          },
        },
      },
      warnings: [],
    }),
  });

  const state = await service.refresh();

  assert.equal(state.status, 'ok');
  assert.equal(state.planDiscovery.status, 'ok');
  assert.deepEqual(state.plans, []);
  assert.ok(
    state.warnings.some((item) => item.code === 'PLAN_CURRENCY_UNROUTABLE')
  );
});

test('plan listing failure leaves one-time and merchant-managed recurring routes usable', async () => {
  const service = makeService({
    discoverPlans: async () => {
      throw new Error('private upstream plan response');
    },
  });

  const state = await service.refresh();

  assert.equal(state.status, 'ok');
  assert.equal(state.planDiscovery.status, 'failed');
  assert.equal(state.planDiscovery.discoveredAt, null);
  assert.equal(state.planDiscovery.error.code, 'PLAN_DISCOVERY_FAILED');
  assert.deepEqual(state.plans, []);
  assert.equal(JSON.stringify(state).includes('private upstream plan response'), false);
  assert.equal(service.assertMerchantAccountId('usd-recurring'), 'usd-recurring');
  assert.deepEqual(service.getPlans(), []);
  assert.throws(
    () => service.assertPlanForRoute('usd-monthly', 'USD'),
    PlanCatalogUnavailableError
  );
});

test('merchant account failure leaves plan discovery not run', async () => {
  let planCalls = 0;
  const service = makeService({
    discover: async () => {
      throw new Error('account discovery failed');
    },
    discoverPlans: async () => {
      planCalls += 1;
      return { plans: [plan()], warnings: [] };
    },
  });

  const state = await service.refresh();

  assert.equal(state.status, 'failed');
  assert.deepEqual(state.planDiscovery, {
    status: 'not_run',
    discoveredAt: null,
    error: null,
  });
  assert.deepEqual(state.plans, []);
  assert.equal(planCalls, 0);
});
