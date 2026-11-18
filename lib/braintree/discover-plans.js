'use strict';

class PlanDiscoveryError extends Error {
  constructor(message, { code = 'PLAN_DISCOVERY_FAILED', cause } = {}) {
    super(message, { cause });
    this.name = 'PlanDiscoveryError';
    this.code = code;
  }
}

function invalidPlan(message) {
  return new PlanDiscoveryError(message, { code: 'INVALID_PLAN_DISCOVERY_RESULT' });
}

function requireString(value, fieldName, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === '')) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidPlan(`Braintree returned a plan without a valid ${fieldName}.`);
  }
  return value.trim();
}

function normalizePositiveInteger(value, fieldName) {
  const candidate = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(candidate)) {
    throw invalidPlan(`Braintree returned a plan without a valid ${fieldName}.`);
  }
  const normalized = Number(candidate);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw invalidPlan(`Braintree returned a plan without a valid ${fieldName}.`);
  }
  return normalized;
}

function normalizePrice(value) {
  const price = requireString(value, 'price');
  if (!/^\d+(?:\.\d+)?$/.test(price)) {
    throw invalidPlan('Braintree returned a plan without a valid price.');
  }
  return price;
}

function normalizeTrial(plan) {
  const enabled = plan.trialPeriod === true;
  if (!enabled) {
    return {
      trialPeriod: false,
      trialDuration: null,
      trialDurationUnit: null,
    };
  }

  const duration = normalizePositiveInteger(plan.trialDuration, 'trial duration');
  const unit = requireString(plan.trialDurationUnit, 'trial duration unit').toLowerCase();
  if (!['day', 'month'].includes(unit)) {
    throw invalidPlan('Braintree returned a plan with an unsupported trial duration unit.');
  }

  return {
    trialPeriod: true,
    trialDuration: duration,
    trialDurationUnit: unit,
  };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw invalidPlan('Braintree returned an invalid subscription plan.');
  }

  const id = requireString(plan.id, 'ID');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw invalidPlan('Braintree returned a plan with an invalid ID.');
  }
  const currency = requireString(
    plan.currencyIsoCode ?? plan.currency,
    'currency'
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw invalidPlan(`Braintree returned an invalid currency for plan ${id}.`);
  }

  return Object.freeze({
    id,
    name: requireString(plan.name, 'name'),
    description: requireString(plan.description, 'description', { nullable: true }),
    currency,
    price: normalizePrice(plan.price),
    billingFrequency: normalizePositiveInteger(
      plan.billingFrequency,
      'billing frequency'
    ),
    ...normalizeTrial(plan),
  });
}

async function listAllPlans(gateway) {
  if (!gateway?.plan?.all) {
    throw new PlanDiscoveryError(
      'A Braintree gateway with the plan API is required.',
      { code: 'PLAN_API_UNAVAILABLE' }
    );
  }

  let result;
  try {
    result = await gateway.plan.all();
  } catch (error) {
    throw new PlanDiscoveryError(
      'Unable to load subscription plans from Braintree Sandbox.',
      { cause: error }
    );
  }

  if (!Array.isArray(result)) {
    throw new PlanDiscoveryError(
      'Braintree Sandbox returned an invalid subscription plan collection.',
      { code: 'INVALID_PLAN_DISCOVERY_RESULT' }
    );
  }

  // braintree@3.40.0 adds enumerable `success` and `plans` properties to this
  // array, with `plans` pointing back to the array itself. Copy only indexed
  // entries immediately so that self-reference never reaches application state.
  return Array.from(result);
}

function planWarning(code, message) {
  return Object.freeze({ code, message });
}

async function discoverPlans(gateway) {
  const rawPlans = await listAllPlans(gateway);
  const candidates = [];
  const warnings = [];

  rawPlans.forEach((rawPlan, index) => {
    try {
      candidates.push(normalizePlan(rawPlan));
    } catch (error) {
      warnings.push(planWarning(
        'PLAN_INVALID',
        `Braintree subscription plan at position ${index + 1} was malformed and was excluded.`
      ));
    }
  });

  const counts = new Map();
  for (const plan of candidates) {
    counts.set(plan.id, (counts.get(plan.id) || 0) + 1);
  }

  const duplicateIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
  for (const id of duplicateIds) {
    warnings.push(planWarning(
      'PLAN_DUPLICATE_ID',
      `Braintree returned subscription plan ${id} more than once; every copy was excluded.`
    ));
  }

  const plans = candidates
    .filter((plan) => counts.get(plan.id) === 1)
    .sort((left, right) => left.id.localeCompare(right.id));

  return Object.freeze({
    plans: Object.freeze(plans),
    warnings: Object.freeze(warnings),
  });
}

module.exports = {
  PlanDiscoveryError,
  discoverPlans,
  listAllPlans,
  normalizePlan,
};
