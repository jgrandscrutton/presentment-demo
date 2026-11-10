const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

function firstDefined(...values) {
  return values.find(value => typeof value === 'string' && value.trim() !== '');
}

function parsePort(value) {
  const port = Number(value || '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return port;
}

function parseEnvironment(value) {
  const environment = (value || 'sandbox').toLowerCase();

  if (!['sandbox', 'production'].includes(environment)) {
    throw new Error('BRAINTREE_ENVIRONMENT must be either "sandbox" or "production".');
  }

  return environment;
}

function parseCurrency(value) {
  const currency = (value || 'GBP').toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('BRAINTREE_CURRENCY must be a three-letter ISO currency code.');
  }

  return currency;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean environment values must be either "true" or "false".');
}

function parseInteger(value, defaultValue, { min, max, name }) {
  const parsed = Number(value ?? defaultValue);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

const projectRoot = path.join(__dirname, '..');

const environment = {
  port: parsePort(process.env.PORT),
  braintree: {
    environment: parseEnvironment(process.env.BRAINTREE_ENVIRONMENT),
    merchantId: firstDefined(process.env.BRAINTREE_MERCHANT_ID, process.env.MERCHANT_ID),
    publicKey: firstDefined(process.env.BRAINTREE_PUBLIC_KEY, process.env.PUBLIC_KEY),
    privateKey: firstDefined(process.env.BRAINTREE_PRIVATE_KEY, process.env.PRIVATE_KEY),
    merchantAccountId: firstDefined(
      process.env.BRAINTREE_MERCHANT_ACCOUNT_ID,
      process.env.MERCHANT_ACCOUNT_ID,
    ),
    currency: parseCurrency(process.env.BRAINTREE_CURRENCY),
  },
  billing: {
    schedulerEnabled: parseBoolean(process.env.BILLING_SCHEDULER_ENABLED),
    schedulerIntervalMs: parseInteger(process.env.BILLING_SCHEDULER_INTERVAL_MS, 60000, {
      min: 1000,
      max: 86400000,
      name: 'BILLING_SCHEDULER_INTERVAL_MS',
    }),
    schedulerBatchSize: parseInteger(process.env.BILLING_SCHEDULER_BATCH_SIZE, 20, {
      min: 1,
      max: 100,
      name: 'BILLING_SCHEDULER_BATCH_SIZE',
    }),
    adminKey: firstDefined(process.env.BILLING_ADMIN_KEY),
    quoteSecret: firstDefined(
      process.env.BILLING_QUOTE_SECRET,
      process.env.BRAINTREE_PRIVATE_KEY,
      process.env.PRIVATE_KEY,
    ),
    quoteTtlSeconds: parseInteger(process.env.BILLING_QUOTE_TTL_SECONDS, 1800, {
      min: 60,
      max: 3600,
      name: 'BILLING_QUOTE_TTL_SECONDS',
    }),
    storePath: path.resolve(
      projectRoot,
      process.env.BILLING_STORE_PATH || 'var/billing-agreements.json',
    ),
  },
};

function assertBraintreeConfiguration() {
  const required = ['merchantId', 'publicKey', 'privateKey'];
  const missing = required.filter(key => !environment.braintree[key]);

  if (missing.length > 0) {
    const names = missing.map(key => `BRAINTREE_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`);
    throw new Error(
      `Missing Braintree configuration: ${names.join(', ')}. ` +
      'Copy .env.example to .env and add your Braintree credentials.',
    );
  }
}

module.exports = {
  ...environment,
  assertBraintreeConfiguration,
};
