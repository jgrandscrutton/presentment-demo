'use strict';

const net = require('node:net');
const dotenv = require('dotenv');
const express = require('express');

dotenv.config({ path: ['./config.env', '.env'], quiet: true });

const {
  assertSandboxConfiguration,
  getConfiguredMerchantId,
  getGatewayClient,
} = require('./lib/braintree/gateway');
const eventStore = require('./lib/events/store');
const { createWebhookRouter } = require('./routes/demo-webhooks');

const DEFAULT_WEBHOOK_PORT = 3001;
const WEBHOOK_HOST = '127.0.0.1';

function parseWebhookPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('WEBHOOK_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function createWebhookReceiverApp({
  gatewayClient,
  store = eventStore,
  logger = console,
  gatewayMerchantId,
} = {}) {
  assertSandboxConfiguration(process.env);
  const merchantId = gatewayMerchantId || getConfiguredMerchantId();
  const client = gatewayClient || getGatewayClient();
  const app = express();

  app.disable('x-powered-by');
  app.use(
    '/api/webhooks',
    createWebhookRouter({
      gatewayClient: client,
      store,
      logger,
      includeActivity: false,
      getGatewayMerchantId: () => merchantId,
    })
  );
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  return app;
}

function startWebhookReceiver({
  port = process.env.WEBHOOK_PORT || DEFAULT_WEBHOOK_PORT,
  host = WEBHOOK_HOST,
  ...appOptions
} = {}) {
  if (host !== 'localhost' && net.isIP(host) === 0) {
    throw new TypeError('The webhook receiver host must be a loopback IP address');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new TypeError('The webhook receiver must remain bound to loopback');
  }

  const resolvedPort = parseWebhookPort(port);
  const app = createWebhookReceiverApp(appOptions);
  return new Promise((resolve, reject) => {
    const server = app.listen(resolvedPort, host);
    server.once('listening', () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address
        ? address.port
        : resolvedPort;
      const displayHost = net.isIP(host) === 6 ? `[${host}]` : host;
      console.log(
        `Webhook-only receiver is running on http://${displayHost}:${listeningPort}/api/webhooks/braintree`
      );
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (require.main === module) {
  startWebhookReceiver().catch((error) => {
    console.error(`Unable to start webhook receiver: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_WEBHOOK_PORT,
  WEBHOOK_HOST,
  createWebhookReceiverApp,
  parseWebhookPort,
  startWebhookReceiver,
};
