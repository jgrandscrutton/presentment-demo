'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const exphbs = require('express-handlebars');

const currency = require('../lib/currency');
const {
  buildStorefrontViewModel,
  createStoreRouter,
} = require('../routes/store');

function account(currencyCode, isDefault = true) {
  return {
    merchantAccountId: `account-${currencyCode.toLowerCase()}`,
    currency: currencyCode,
    isDefault,
  };
}

function invokeGet(router, routePath, { query = {}, params = {} } = {}) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods.get
  );
  if (!layer) throw new Error(`No GET route registered for ${routePath}`);

  return new Promise((resolve, reject) => {
    const req = { query, params };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, model) {
        resolve({ status: this.statusCode, view, model });
      },
      send(body) {
        resolve({ status: this.statusCode, body });
      },
    };

    try {
      Promise.resolve(layer.route.stack[0].handle(req, res, reject)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

test('storefront converts each GBP base price exactly once into the discovered default currency', () => {
  const model = buildStorefrontViewModel({ accounts: [account('USD')] });

  assert.equal(model.storefront.currency, 'USD');
  assert.equal(model.storefront.defaultMerchantAccountId, 'account-usd');
  assert.equal(model.prices.subscription.gbpAmount, '35');
  assert.equal(model.prices.subscription.amount, '45.15');
  assert.equal(model.prices.bundleSetup.amount, '256.71');
  assert.equal(
    model.storefront.rateLabel,
    'Fixed demo rate: GBP 1 = USD 1.29 — not a live FX quote'
  );
});

test('storefront uses whole-number rounding and formatting for a zero-decimal default currency', () => {
  const model = buildStorefrontViewModel({ accounts: [account('JPY')] });

  assert.equal(model.storefront.currency, 'JPY');
  assert.equal(model.storefront.decimalPlaces, 0);
  assert.equal(model.storefront.step, '1');
  assert.equal(model.storefront.zeroAmount, '0');
  assert.equal(model.prices.subscription.amount, '6685');
  assert.equal(model.prices.iphone15.amount, '190809');
  assert.doesNotMatch(model.prices.subscription.amount, /\./);
  assert.equal(
    model.prices.subscription.formatted,
    currency.formatCurrencyAmount('6685', 'JPY')
  );
});

test('store route renders converted amounts and billing payload currency from the live default account', async () => {
  const router = createStoreRouter({
    getAccounts: () => [account('EUR')],
  });
  const response = await invokeGet(router, '/subscription');

  assert.equal(response.view, 'subscription');
  assert.equal(response.model.storefront.currency, 'EUR');
  assert.equal(response.model.prices.subscription.amount, '41.30');

  const handlebars = exphbs.create({
    extname: '.hbs',
    defaultLayout: 'store',
    layoutsDir: path.join(__dirname, '..', 'views', 'layouts'),
  });
  const html = await handlebars.renderView(
    path.join(__dirname, '..', 'views', 'subscription.hbs'),
    response.model
  );

  assert.match(html, /€41\.30/);
  assert.match(html, /amount: '41\.30'/);
  assert.match(html, /currency: 'EUR'/);
  assert.match(html, /Fixed demo rate: GBP 1 &#x3D; EUR 1\.18/);
  assert.match(html, /not a live FX quote/);
});

test('device prices are converted once on the server and remain canonical in the browser payload', async () => {
  const deviceCatalog = [
    {
      id: 'demo-phone',
      brand: 'Demo',
      name: 'Phone',
      category: 'flagship',
      storage: [
        { size: '128GB', monthlyPrice: 10, upfrontPrice: 99 },
        { size: '256GB', monthlyPrice: 12, upfrontPrice: 125 },
      ],
      fullSpecs: { Display: 'Demo' },
    },
  ];
  const router = createStoreRouter({
    getAccounts: () => [account('JPY')],
    deviceCatalog,
  });
  const response = await invokeGet(router, '/devices/:id', {
    params: { id: 'demo-phone' },
  });

  assert.equal(response.model.device.storage[0].upfrontAmount, '18909');
  assert.equal(response.model.device.storage[1].upfrontAmount, '23875');
  assert.doesNotMatch(response.model.device.storage[0].upfrontAmount, /\./);
});

test('browser payment flow has no gateway-specific currency or forced two-decimal amount', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'scripts', 'payment-flow.js'),
    'utf8'
  );
  const basicSource = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'basic.hbs'),
    'utf8'
  );

  assert.match(source, /getStoreCurrency\(billingData\)/);
  assert.match(source, /document\.body\.dataset\.storeCurrency/);
  assert.doesNotMatch(source, /['"](?:GBP|USD)['"]/);
  assert.doesNotMatch(source, /toFixed\(2\)/);
  assert.doesNotMatch(basicSource, /['"](?:GBP|USD)['"]/);
  assert.doesNotMatch(basicSource, /toFixed\(2\)/);
  assert.match(basicSource, /currencyIsoCode: planDetails\.currencyIsoCode/);
  assert.match(source, /fetch\('\/api\/client-token\?paymentType=recurring'\)/);
  assert.match(source, /fetch\('\/api\/client-token'\)/);
  assert.match(basicSource, /fetch\('\/api\/client-token\?paymentType=recurring'\)/);
});

