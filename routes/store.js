'use strict';

const express = require('express');
const devices = require('../data/devices');
const { getMerchantAccounts } = require('../config/merchant-accounts');
const currency = require('../lib/currency');

const BASE_GBP_PRICES = Object.freeze({
  subscription: '35',
  paygMinimum: '15',
  paygInitial: '25',
  installmentMonthly: '41.62',
  bundleSetup: '199',
  bundleMonthly: '60',
  reload: '50',
  reloadThreshold: '10',
  iphone15: '999',
  basicSubscription: '9.99',
  basicInstallment: '100',
});

function findDefaultAccount(accounts) {
  if (!Array.isArray(accounts)) {
    throw new TypeError('The discovered merchant account catalog is unavailable');
  }

  const defaults = accounts.filter((account) => account.isDefault === true);
  if (defaults.length !== 1) {
    throw new TypeError(
      `The discovered merchant account catalog must contain exactly one default account; received ${defaults.length}`
    );
  }

  return defaults[0];
}

function createPrice(gbpAmount, currencyCode, currencyTools) {
  const amount = currencyTools.convertGbpAmount(gbpAmount, currencyCode);
  return Object.freeze({
    amount,
    formatted: currencyTools.formatCurrencyAmount(amount, currencyCode),
    gbpAmount: String(gbpAmount),
  });
}

function buildStorefrontViewModel({ accounts, currencyTools = currency } = {}) {
  const defaultAccount = findDefaultAccount(accounts);
  const currencyCode = defaultAccount.currency;
  const rate = currencyTools.getDemoRate(currencyCode);
  const range = currencyTools.getCurrencyAmountRange(currencyCode);
  const zeroAmount = range.decimalPlaces === 0 ? '0' : '0.00';
  const prices = Object.fromEntries(
    Object.entries(BASE_GBP_PRICES).map(([key, gbpAmount]) => [
      key,
      createPrice(gbpAmount, currencyCode, currencyTools),
    ])
  );

  return Object.freeze({
    storefront: Object.freeze({
      currency: currencyCode,
      defaultMerchantAccountId: defaultAccount.merchantAccountId,
      decimalPlaces: range.decimalPlaces,
      step: range.step,
      zeroAmount,
      zeroFormatted: currencyTools.formatCurrencyAmount(zeroAmount, currencyCode),
      rate: rate.rate,
      rateLabel: `Fixed demo rate: ${rate.baseCurrency} 1 = ${rate.currency} ${rate.rate} — not a live FX quote`,
    }),
    prices: Object.freeze(prices),
  });
}

function convertDevice(device, currencyCode, currencyTools) {
  const storage = device.storage.map((option) => {
    const monthlyAmount = currencyTools.convertGbpAmount(
      option.monthlyPrice,
      currencyCode
    );
    const upfrontAmount = currencyTools.convertGbpAmount(
      option.upfrontPrice,
      currencyCode
    );

    return {
      ...option,
      monthlyAmount,
      monthlyFormatted: currencyTools.formatCurrencyAmount(
        monthlyAmount,
        currencyCode
      ),
      upfrontAmount,
      upfrontFormatted: currencyTools.formatCurrencyAmount(
        upfrontAmount,
        currencyCode
      ),
    };
  });

  return {
    ...device,
    storage,
    monthlyAmount: storage[0].monthlyAmount,
    monthlyFormatted: storage[0].monthlyFormatted,
    upfrontAmount: storage[0].upfrontAmount,
    upfrontFormatted: storage[0].upfrontFormatted,
  };
}

function formatResultAmount(rawAmount, currencyCode, currencyTools, fallback) {
  try {
    return currencyTools.formatCurrencyAmount(rawAmount, currencyCode);
  } catch {
    return currencyTools.formatCurrencyAmount(fallback, currencyCode);
  }
}

function createStoreRouter({
  getAccounts = getMerchantAccounts,
  currencyTools = currency,
  deviceCatalog = devices,
} = {}) {
  const router = express.Router();

  function context() {
    return buildStorefrontViewModel({
      accounts: getAccounts(),
      currencyTools,
    });
  }

  function renderWithStorefront(view, options = {}) {
    return (req, res, next) => {
      try {
        res.render(view, { ...options, ...context() });
      } catch (error) {
        next(error);
      }
    };
  }

  router.get('/', renderWithStorefront('index', { title: 'Recurring Billing' }));
  router.get(
    '/subscription',
    renderWithStorefront('subscription', { title: 'Unlimited Data Plan' })
  );
  router.get(
    '/recurring',
    renderWithStorefront('recurring', { title: 'Pay As You Go Plan' })
  );
  router.get(
    '/installments',
    renderWithStorefront('installments', { title: 'iPhone 15' })
  );
  router.get(
    '/bundled',
    renderWithStorefront('bundled', { title: 'Phone + Plan Bundle' })
  );
  router.get(
    '/unscheduled',
    renderWithStorefront('unscheduled', { title: 'Auto-Reload Prepaid' })
  );

  router.get('/success', (req, res, next) => {
    try {
      const model = context();
      const currencyCode = model.storefront.currency;
      const amount = req.query.amount || model.storefront.zeroAmount;
      const recurringAmount = req.query.recurring || null;

      res.render('success', {
        title: 'Payment Successful',
        ...model,
        transactionId: req.query.txnId || 'N/A',
        productName: req.query.product || 'N/A',
        amount,
        amountFormatted: formatResultAmount(
          amount,
          currencyCode,
          currencyTools,
          model.storefront.zeroAmount
        ),
        recurringAmount,
        recurringAmountFormatted: recurringAmount
          ? formatResultAmount(
              recurringAmount,
              currencyCode,
              currencyTools,
              model.storefront.zeroAmount
            )
          : null,
        frequency: req.query.freq || 'month',
        isVariable: req.query.variable === 'true',
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/webhook-activity', (req, res, next) => {
    try {
      res.render('webhook-activity', {
        title: 'Webhook Activity',
        ...context(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/devices', (req, res, next) => {
    try {
      const model = context();
      const { category } = req.query;
      const filtered = category
        ? deviceCatalog.filter((device) => device.category === category)
        : deviceCatalog;

      res.render('devices', {
        title: 'Devices',
        ...model,
        devices: filtered.map((device) =>
          convertDevice(device, model.storefront.currency, currencyTools)
        ),
        activeCategory: category || 'all',
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/devices/:id', (req, res, next) => {
    try {
      const sourceDevice = deviceCatalog.find((device) => device.id === req.params.id);
      if (!sourceDevice) return res.status(404).send('Device not found');

      const model = context();
      const device = convertDevice(
        sourceDevice,
        model.storefront.currency,
        currencyTools
      );
      return res.render('device-detail', {
        title: `${device.brand} ${device.name}`,
        ...model,
        device,
        fullSpecsArray: Object.entries(device.fullSpecs).map(([label, value]) => ({
          label,
          value,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

const router = createStoreRouter();

module.exports = router;
module.exports.BASE_GBP_PRICES = BASE_GBP_PRICES;
module.exports.buildStorefrontViewModel = buildStorefrontViewModel;
module.exports.createStoreRouter = createStoreRouter;
