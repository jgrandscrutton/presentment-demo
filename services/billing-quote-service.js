const crypto = require('node:crypto');
const environment = require('../config/environment');
const { ValidationError } = require('./billing-service');
const { nextBillingDate } = require('./schedule-service');

function quoteSecret() {
  if (!environment.billing.quoteSecret) {
    throw new Error(
      'BILLING_QUOTE_SECRET or BRAINTREE_PRIVATE_KEY is required to sign billing quotes.',
    );
  }

  return environment.billing.quoteSecret;
}

function signature(encodedPayload) {
  return crypto
    .createHmac('sha256', quoteSecret())
    .update(encodedPayload)
    .digest('base64url');
}

function createSignedQuote(contents, audience, now) {
  const issuedAt = Math.floor(new Date(now).getTime() / 1000);
  const payload = {
    version: 1,
    id: crypto.randomUUID(),
    audience,
    issuedAt,
    expiresAt: issuedAt + environment.billing.quoteTtlSeconds,
    ...contents,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return {
    token: `${encodedPayload}.${signature(encodedPayload)}`,
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
  };
}

function createBillingQuote(billingPlan, audience, now = new Date()) {
  const plan = structuredClone(billingPlan);

  if (plan.planDetails.frequency) {
    plan.planDetails.firstBillingDate = nextBillingDate(
      new Date(now),
      plan.planDetails.frequency,
    ).toISOString().split('T')[0];
  }

  return {
    ...createSignedQuote({ billingPlan: plan }, audience, now),
    plan,
  };
}

function resolveSignedQuote(token, expectedAudience, now) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 10000) {
    throw new ValidationError('A valid checkout quote is required. Refresh the page and try again.');
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new ValidationError('The checkout quote is invalid. Refresh the page and try again.');
  }

  const [encodedPayload, receivedSignature] = parts;
  const expectedSignature = signature(encodedPayload);
  const receivedBuffer = Buffer.from(receivedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new ValidationError('The checkout quote is invalid. Refresh the page and try again.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('The checkout quote is invalid. Refresh the page and try again.');
  }

  const currentTime = Math.floor(new Date(now).getTime() / 1000);
  if (
    payload.version !== 1 ||
    payload.audience !== expectedAudience ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt <= currentTime
  ) {
    throw new ValidationError('The checkout quote has expired or is invalid. Refresh the page and try again.');
  }

  return payload;
}

function resolveBillingQuote(token, expectedAudience, now = new Date()) {
  const payload = resolveSignedQuote(token, expectedAudience, now);
  if (!payload.billingPlan?.planDetails) {
    throw new ValidationError('The billing quote is invalid. Refresh the page and try again.');
  }

  return structuredClone(payload.billingPlan);
}

function createPurchaseQuote(purchase, now = new Date()) {
  const safePurchase = structuredClone(purchase);
  return {
    ...createSignedQuote({ purchase: safePurchase }, 'one-time', now),
    purchase: safePurchase,
  };
}

function resolvePurchaseQuote(token, now = new Date()) {
  const payload = resolveSignedQuote(token, 'one-time', now);
  if (!payload.purchase || typeof payload.purchase !== 'object') {
    throw new ValidationError('The purchase quote is invalid. Refresh the page and try again.');
  }

  return structuredClone(payload.purchase);
}

module.exports = {
  createBillingQuote,
  resolveBillingQuote,
  createPurchaseQuote,
  resolvePurchaseQuote,
};
