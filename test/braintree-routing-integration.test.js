'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApp } = require('../app');
const { createDemoRouter } = require('../routes/demo');
const { createDemoApiRouter } = require('../routes/demo-api');
const { createGateway, getConfiguredMerchantId } = require('../lib/braintree/gateway');

function fixtureCatalog() {
  const account = { key: 'cad-account', merchantAccountId: 'cad-account', label: 'CAD account',
    currency: 'CAD', status: 'active', isDefault: true, environment: 'sandbox',
    paymentTypes: ['one_time', 'recurring'], paymentMethods: ['card'],
    threeDSecurePolicy: 'optional', purpose: 'Integration fixture', roleSource: 'auto',
    assignmentState: 'assigned', paymentTypeSources: { one_time: 'auto', recurring: 'auto' },
    routingReasons: { one_time: 'Fixture account', recurring: 'Fixture account' } };
  return {
    getState: () => ({ status: 'ok', gatewayMerchantId: 'integration-gateway', accounts: [account],
      plans: [], warnings: [], policyStatus: 'auto', planDiscovery: { status: 'ok' } }),
    getMerchantAccounts: () => [account],
    getPublicMerchantAccounts: () => [account],
  };
}

test('Braintree storefront and Routing demo coexist with separate payment APIs', async (t) => {
  const catalog = fixtureCatalog();
  const store = { append: (event) => ({ ...event, id: 'integration-event' }) };
  const api = express.Router();
  api.get('/client-token', (req, res) => res.json({ clientToken: 'storefront-fixture', currency: 'GBP' }));
  const app = createApp({ catalogService: catalog, requestLogger: null,
    routers: {
      api,
      demo: createDemoRouter({ getCatalogService: () => catalog }),
      demoApi: createDemoApiRouter({ catalogService: catalog, store, gatewayClient: {} }),
    } });
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/devices', '/devices/iphone-16', '/basic']) {
    const response = await fetch(baseUrl + route);
    assert.equal(response.status, 200, route);
    assert.doesNotMatch(await response.text(), /class="routing-demo"/);
  }
  const storefront = await fetch(baseUrl + '/api/client-token');
  assert.deepEqual(await storefront.json(), { clientToken: 'storefront-fixture', currency: 'GBP' });
  const demo = await fetch(baseUrl + '/demo');
  const html = await demo.text();
  assert.equal(demo.status, 200);
  assert.match(html, /class="routing-demo"/);
  assert.match(html, /Route payments with clear proof/);
  const preview = await fetch(baseUrl + '/api/demo/route-preview', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currency: 'CAD', paymentType: 'recurring' }) });
  const decision = await preview.json();
  assert.equal(preview.status, 200);
  assert.equal(decision.route.account.merchantAccountId, 'cad-account');
  const health = await fetch(baseUrl + '/health');
  assert.equal((await health.json()).gatewayMerchantId, 'integration-gateway');
});

test('Routing demo accepts Braintree credential names and retains Sandbox enforcement', () => {
  const configuration = { BRAINTREE_ENVIRONMENT: 'sandbox', BRAINTREE_MERCHANT_ID: 'canonical-merchant',
    BRAINTREE_PUBLIC_KEY: 'dummy-public', BRAINTREE_PRIVATE_KEY: 'dummy-private', MERCHANT_ID: 'legacy-merchant' };
  assert.equal(getConfiguredMerchantId(configuration), 'canonical-merchant');
  assert.doesNotThrow(() => createGateway(configuration));
  assert.throws(() => createGateway({ ...configuration, BRAINTREE_ENVIRONMENT: 'production' }), /Sandbox/);
  assert.equal(getConfiguredMerchantId({ MERCHANT_ID: 'legacy-merchant' }), 'legacy-merchant');
});
