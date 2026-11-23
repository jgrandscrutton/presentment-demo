const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { quote } = require('../services/storefront-quote');
const devices = require('../data/devices');
const paymentRouter = require('../routes/storefront-payment');

const device = devices[0];
const sales = [];
const account = { id: 'gbp-sandbox', default: true, currencyIsoCode: 'GBP' };
const gateway = {
  merchantAccount: { all: callback => callback(null, [account]), find: async () => account },
  clientToken: { generate: async () => ({ clientToken: 'test-client-token' }) },
  paymentMethodNonce: { find: async nonce => nonce.startsWith('card') ? { type: 'CreditCard', threeDSecureInfo: { liabilityShifted: nonce === 'card-verified' } } : { type: 'PayPalAccount' } },
  transaction: { sale: async options => {
    sales.push(options);
    return options.paymentMethodNonce === 'declined' ? { success: false, message: 'Processor declined' } : { success: true, transaction: { id: 'sandbox-transaction', amount: options.amount } };
  } },
};
const gatewayPath = require.resolve('../config/braintree');
require.cache[gatewayPath] = { id: gatewayPath, filename: gatewayPath, loaded: true, exports: gateway };
process.env.MERCHANT_ACCOUNT_ID = '';
const app = require('../app');
let server;
let base;
before(async () => {
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function browser() {
  let cookie;
  return async function request(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), text, json: () => JSON.parse(text) };
  };
}

test('device and basket prices come from the catalogue, ignoring submitted prices', () => {
  const result = quote({ kind: 'device', deviceId: device.id, amount: '0.01' });
  assert.equal(result.amount, device.storage[0].upfrontPrice.toFixed(2));
  const cart = [{ deviceId: device.id, colour: device.colours[0], size: device.storage[0].size, quantity: 2, upfrontPrice: 0.01 }];
  assert.equal(quote({ kind: 'cart' }, cart).amount, (device.storage[0].upfrontPrice * 2).toFixed(2));
});

test('plan choices calculate discounts and top-ups in GBP', () => {
  const fixed = quote({ kind: 'plan', planId: 'basic', contractLengthId: '12month' });
  assert.equal(fixed.amount, '7.60');
  assert.equal(fixed.currency, 'GBP');
  assert.equal(fixed.paymentOptions.planType, 'SUBSCRIPTION');
  const topup = quote({ kind: 'plan', planId: 'autotopup', topUpAmount: 30, threshold: 5 });
  assert.equal(topup.amount, '30.00');
  assert.equal(topup.paymentOptions.planMetadata.billingCycles[0].pricingScheme.reloadThresholdAmount, '5.00');
  assert.equal(quote({ kind: 'plan', planId: 'variable' }).paymentOptions.planType, 'RECURRING');
});

test('invalid catalogue choices and quantities are rejected', () => {
  for (const input of [
    { kind: 'device', deviceId: 'unknown' }, { kind: 'device', deviceId: device.id, storageIndex: -1 },
    { kind: 'device', deviceId: device.id, colour: '<script>' },
    { kind: 'plan', planId: 'basic', contractLengthId: 'free' },
    { kind: 'plan', planId: 'autotopup', topUpAmount: 0.01 },
    { kind: 'cart' },
  ]) assert.throws(() => quote(input, []));
});

test('the restored storefront, plans and existing Braintree demos render', async () => {
  const request = browser();
  for (const path of ['/', '/devices', `/devices/${device.id}`, '/plans', '/plans/basic', '/plans/variable', '/plans/autotopup', '/cart', '/basic', '/subscription', '/webhook-activity']) {
    const page = await request(path);
    assert.equal(page.status, 200, path);
    assert.doesNotMatch(page.text, /web-sdk\/v6|PAYPAL_CONFIG|\/scripts\/paypal-checkout\.js|\/api\/paypal/);
  }
  const home = await request('/');
  assert.match(home.text, /Merchant &amp; Co\./);
  assert.match(home.text, /\/css\/style\.css/);
});

test('basket selections, quantity updates and checkout steps persist in the session', async () => {
  const request = browser();
  assert.equal((await request('/checkout')).location, '/cart');
  assert.equal((await request('/cart/add', { deviceId: device.id, storageIndex: 0 })).json().cartCount, 1);
  const basket = await request('/cart');
  assert.match(basket.text, /Your Basket/);
  assert.match(basket.text, /data-storefront-payment/);
  assert.equal((await request('/checkout')).status, 200);
  assert.equal((await request('/checkout/account', { email: 'buyer@example.test' })).location, '/checkout/shipping');
  assert.equal((await request('/checkout/shipping', { firstName: 'Test', lastName: 'Buyer', line1: '1 Test Road', city: 'London', postcode: 'SW1A 1AA', country: 'GB' })).location, '/checkout/payment');
  const payment = await request('/checkout/payment');
  assert.equal(payment.status, 200);
  assert.match(payment.text, /hosted-fields\.min\.js/);
  assert.match(payment.text, /three-d-secure\.min\.js/);
  assert.doesNotMatch(payment.text, /paypalClientId/);
  assert.equal((await request('/checkout/payment', {})).status, 400);
  assert.equal((await request('/checkout/confirmation')).status, 302);
});

test('Braintree client tokens use a GBP merchant account', async () => {
  const result = await browser()('/api/storefront/client-token');
  assert.equal(result.status, 200);
  assert.equal(result.json().clientToken, 'test-client-token');
});

test('successful Braintree payment records a receipt and clears the paid basket', async () => {
  const request = browser();
  await request('/cart/add', { deviceId: device.id });
  const prepared = (await request('/api/storefront/quote', { kind: 'cart', amount: '0.01' })).json();
  const paid = await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'paypal-approved', amount: '0.01' });
  assert.equal(paid.status, 200);
  assert.equal(sales.at(-1).amount, device.storage[0].upfrontPrice.toFixed(2));
  assert.equal(sales.at(-1).merchantAccountId, 'gbp-sandbox');
  assert.equal(sales.at(-1).options.submitForSettlement, true);
  assert.match((await request('/checkout/confirmation')).text, /sandbox-transaction/);
  assert.match((await request('/cart')).text, /Your basket is empty/);
  const count = sales.length;
  assert.equal((await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'paypal-approved' })).status, 200);
  assert.equal(sales.length, count, 'retries must not create another charge');
});

test('a declined payment keeps the basket and does not create a receipt', async () => {
  const request = browser();
  await request('/cart/add', { deviceId: device.id });
  const prepared = (await request('/api/storefront/quote', { kind: 'cart' })).json();
  assert.equal((await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'declined' })).status, 400);
  assert.match((await request('/cart')).text, /Order Summary/);
  assert.equal((await request('/checkout/confirmation')).status, 302);
});

test('changing the basket invalidates an earlier payment quote', async () => {
  const request = browser();
  await request('/cart/add', { deviceId: device.id });
  const prepared = (await request('/api/storefront/quote', { kind: 'cart' })).json();
  await request('/cart/add', { deviceId: device.id });
  const count = sales.length;
  assert.equal((await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'paypal-approved' })).status, 409);
  assert.equal(sales.length, count);
});

test('card payments require gateway-confirmed 3D Secure authentication', async () => {
  const request = browser();
  const prepared = (await request('/api/storefront/quote', { kind: 'device', deviceId: device.id })).json();
  const count = sales.length;
  assert.equal((await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'card-unverified', method: 'paypal' })).status, 400);
  assert.equal(sales.length, count);
  assert.equal((await request('/api/storefront/pay', { quoteId: prepared.id, nonce: 'card-verified' })).status, 200);
  assert.deepEqual(sales.at(-1).options.threeDSecure, { required: true });
});

test('a USD merchant account is rejected before issuing a storefront token', async () => {
  const isolated = express();
  isolated.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
  isolated.use(paymentRouter({ ...gateway, merchantAccount: { all: callback => callback(null, [{ id: 'usd', default: true, currencyIsoCode: 'USD' }]) } }));
  const instance = await new Promise(resolve => { const listening = isolated.listen(0, '127.0.0.1', () => resolve(listening)); });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.address().port}/client-token`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GBP/);
  } finally { await new Promise(resolve => instance.close(resolve)); }
});
