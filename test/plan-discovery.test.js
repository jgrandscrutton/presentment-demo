'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  discoverPlans,
  normalizePlan,
  PlanDiscoveryError,
} = require('../lib/braintree/discover-plans');

function rawPlan(overrides = {}) {
  return {
    id: 'monthly-usd',
    name: 'Monthly USD',
    description: 'A monthly sandbox plan.',
    currencyIsoCode: 'usd',
    price: '12.50',
    billingFrequency: 1,
    trialPeriod: true,
    trialDuration: 2,
    trialDurationUnit: 'month',
    ...overrides,
  };
}

test('normalizes the documented safe plan fields and trial metadata', () => {
  const plan = normalizePlan(rawPlan());

  assert.deepEqual(plan, {
    id: 'monthly-usd',
    name: 'Monthly USD',
    description: 'A monthly sandbox plan.',
    currency: 'USD',
    price: '12.50',
    billingFrequency: 1,
    trialPeriod: true,
    trialDuration: 2,
    trialDurationUnit: 'month',
  });
  assert.ok(Object.isFrozen(plan));

  assert.deepEqual(normalizePlan(rawPlan({
    id: 'without-trial',
    description: '',
    trialPeriod: false,
    trialDuration: 'not-returned',
    trialDurationUnit: 'not-returned',
  })), {
    id: 'without-trial',
    name: 'Monthly USD',
    description: null,
    currency: 'USD',
    price: '12.50',
    billingFrequency: 1,
    trialPeriod: false,
    trialDuration: null,
    trialDurationUnit: null,
  });
});

test('copies the SDK plan array before its enumerable self-reference can enter state', async () => {
  const sdkResult = [rawPlan()];
  sdkResult.success = true;
  sdkResult.plans = sdkResult;

  const result = await discoverPlans({
    plan: {
      all: async () => sdkResult,
    },
  });

  assert.equal(result.plans.length, 1);
  assert.equal(Object.hasOwn(result.plans, 'plans'), false);
  assert.equal(Object.hasOwn(result.plans, 'success'), false);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.plans));
});

test('excludes malformed and duplicate plans with safe warnings', async () => {
  const result = await discoverPlans({
    plan: {
      all: async () => [
        rawPlan({ id: 'kept-plan' }),
        rawPlan({ id: 'sensitive value must not leak' }),
        rawPlan({ id: 'duplicate-plan' }),
        rawPlan({ id: 'duplicate-plan', currencyIsoCode: 'EUR' }),
      ],
    },
  });

  assert.deepEqual(result.plans.map((plan) => plan.id), ['kept-plan']);
  assert.deepEqual(
    result.warnings.map((item) => item.code).sort(),
    ['PLAN_DUPLICATE_ID', 'PLAN_INVALID']
  );
  assert.equal(
    JSON.stringify(result.warnings).includes('sensitive value must not leak'),
    false
  );
});

test('wraps plan API failures without exposing the upstream error', async () => {
  await assert.rejects(
    () => discoverPlans({
      plan: {
        all: async () => {
          throw new Error('private gateway response');
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof PlanDiscoveryError);
      assert.equal(error.code, 'PLAN_DISCOVERY_FAILED');
      assert.equal(error.message.includes('private gateway response'), false);
      return true;
    }
  );

  await assert.rejects(
    () => discoverPlans({}),
    (error) => error.code === 'PLAN_API_UNAVAILABLE'
  );
});
