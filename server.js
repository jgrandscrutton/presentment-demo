'use strict';

const net = require('node:net');
const dotenv = require('dotenv');

dotenv.config({ path: ['./config.env', '.env'], quiet: true });

const { configureCatalogService } = require('./config/merchant-accounts');
const {
  assertSandboxConfiguration,
  getConfiguredMerchantId,
  getGateway,
} = require('./lib/braintree/gateway');
const { CatalogUnavailableError } = require('./lib/catalog/errors');
const { createCatalogService } = require('./lib/catalog/service');

function getServerHost(environment = process.env) {
  const configured = environment.HOST;
  if (configured == null || String(configured).trim() === '') {
    return '127.0.0.1';
  }

  const host = String(configured).trim();
  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;
  const validHostname =
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split('.').every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    );
  if (net.isIP(host) === 0 && !validHostname) {
    throw new TypeError('HOST must be a valid hostname or IP address');
  }
  return host;
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}

function createFailedCatalogService({ merchantId, message }) {
  const state = Object.freeze({
    status: 'failed',
    gatewayMerchantId: merchantId || null,
    discoveredAt: null,
    error: Object.freeze({
      code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED',
      message,
    }),
    warnings: Object.freeze([]),
    policyStatus: 'not_loaded',
    accounts: Object.freeze([]),
  });
  const unavailable = () => {
    throw new CatalogUnavailableError(message);
  };

  return Object.freeze({
    getState: () => structuredClone(state),
    refresh: async () => structuredClone(state),
    getMerchantAccounts: unavailable,
    getPublicMerchantAccounts: unavailable,
    getMerchantAccountByKey: unavailable,
    getMerchantAccountById: unavailable,
    getDefaultMerchantAccount: unavailable,
    hasMerchantAccountId: unavailable,
    assertMerchantAccountId: unavailable,
  });
}

async function configureRuntimeCatalog() {
  // An explicitly production-configured process is a configuration error, not
  // a transient discovery outage. Bad/missing Sandbox credentials still use
  // the safe unavailable state below so the presenter can open diagnostics.
  assertSandboxConfiguration(process.env);
  let service;
  try {
    service = createCatalogService({
      gateway: getGateway(),
      merchantId: getConfiguredMerchantId(),
      environment: 'sandbox',
    });
  } catch {
    service = createFailedCatalogService({
      merchantId:
        typeof process.env.MERCHANT_ID === 'string'
          ? process.env.MERCHANT_ID.trim()
          : null,
      message:
        'Braintree Sandbox configuration is unavailable. Check the server credentials and restart.',
    });
    configureCatalogService(service);
    return service.getState();
  }

  configureCatalogService(service);
  return service.refresh();
}

async function startServer({
  port = process.env.PORT || 3000,
  host = getServerHost(),
} = {}) {
  const discovery = await configureRuntimeCatalog();
  if (discovery.status === 'ok') {
    console.log(
      `Discovered ${discovery.accounts.length} Braintree Sandbox merchant accounts.`
    );
  } else {
    console.warn(`Gateway discovery unavailable: ${discovery.error?.message || 'Unknown error'}`);
  }

  const app = require('./app');
  return new Promise((resolve, reject) => {
    if (!isLoopbackHost(host)) {
      console.warn(
        `Server explicitly exposed on ${host}. Keep this Sandbox demo on a trusted network because lifecycle actions are presenter controls.`
      );
    }
    const server = app.listen(port, host);
    server.once('listening', () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address ? address.port : port;
      const displayHost = net.isIP(host) === 6 ? `[${host}]` : host;
      console.log(`Server is running on http://${displayHost}:${listeningPort}`);
      resolve(server);
    });
    server.once('error', (error) => {
      console.error(`Unable to start server: ${error.message}`);
      reject(error);
    });
  });
}

if (require.main === module) {
  startServer().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  configureRuntimeCatalog,
  createFailedCatalogService,
  getServerHost,
  isLoopbackHost,
  startServer,
};
