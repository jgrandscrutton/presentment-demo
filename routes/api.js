'use strict';

const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const { summarizeGatewayResult, verifyMerchantAccount } = require('../lib/braintree/result');
const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const { formatCurrencyAmount, getCurrencyDecimalPlaces } = require('../lib/currency');
const eventStore = require('../lib/events/store');
const { resolveRoute } = require('../lib/routing/resolve-route');
const webhookRouter = require('./webhooks');

const FREQUENCY_MAP = Object.freeze({
  weekly: 'WEEK',
  monthly: 'MONTH',
  yearly: 'YEAR',
});

const CLIENT_TOKEN_PAYMENT_TYPES = new Set(['one_time', 'recurring']);

function sendProblem(res, status, code, message) {
  return res.status(status).json({ success: false, error: message, code });
}

function normalizeStorefrontAmount(value, currency) {
  const decimalPlaces = getCurrencyDecimalPlaces(currency);
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const pattern = decimalPlaces === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(?:\\.\\d{1,${decimalPlaces}})?$`);

  if (!pattern.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalized = decimalPlaces === 0
    ? normalizedWhole
    : `${normalizedWhole}.${fraction.padEnd(decimalPlaces, '0')}`;
  const minorUnits = BigInt(`${normalizedWhole}${fraction.padEnd(decimalPlaces, '0')}`);
  return minorUnits > 0n ? normalized : null;
}

function addStorefrontAmounts(left, right, currency) {
  const decimalPlaces = getCurrencyDecimalPlaces(currency);
  const factor = 10n ** BigInt(decimalPlaces);
  const toMinor = (amount) => {
    const [whole, fraction = ''] = amount.split('.');
    return (BigInt(whole) * factor) + BigInt(fraction.padEnd(decimalPlaces, '0') || '0');
  };
  const total = toMinor(left) + toMinor(right);
  if (decimalPlaces === 0) return total.toString();
  return `${total / factor}.${(total % factor).toString().padStart(decimalPlaces, '0')}`;
}

function getStorefrontRoutes(service) {
  const state = service.getState();
  if (state.status !== 'ok') {
    const error = new Error(
      state.error?.message || 'Merchant account discovery has not completed.'
    );
    error.code = 'CATALOG_UNAVAILABLE';
    throw error;
  }

  const accounts = service.getMerchantAccounts();
  const defaultAccount = accounts.find((account) => account.isDefault);
  if (!defaultAccount) {
    const error = new Error('The discovered catalog has no default merchant account.');
    error.code = 'CATALOG_UNAVAILABLE';
    throw error;
  }

  const oneTime = resolveRoute(
    { currency: defaultAccount.currency, paymentType: 'one_time' },
    accounts
  );
  const recurring = resolveRoute(
    { currency: defaultAccount.currency, paymentType: 'recurring' },
    accounts
  );
  if (!oneTime.matched || !recurring.matched) {
    const error = new Error(
      `No complete storefront route is available for ${defaultAccount.currency}.`
    );
    error.code = 'CATALOG_UNAVAILABLE';
    throw error;
  }

  return { currency: defaultAccount.currency, oneTime, recurring };
}

function appendLegacyRouteEvent(store, route, scenarioId, endpoint) {
  return store.append({
    type: 'route_resolution',
    stage: 1.5,
    source: 'storefront',
    endpoint,
    scenarioId,
    intent: route.intent,
    resolvedMerchantAccountId: route.account.merchantAccountId,
    currency: route.intent.currency,
    outcome: 'matched',
    route,
  });
}

async function executeLegacySale({
  gateway,
  store,
  route,
  amount,
  nonce,
  scenarioId,
  orderId,
  logger,
}) {
  const request = {
    scenarioId,
    currency: route.intent.currency,
    paymentType: route.intent.paymentType,
    amount,
    paymentMethod: 'paypal',
  };
  appendLegacyRouteEvent(store, route, scenarioId, 'legacy-sale');

  let result;
  try {
    result = await gateway.createSale({
      amount,
      paymentMethodNonce: nonce,
      merchantAccountId: route.account.merchantAccountId,
      orderId,
      submitForSettlement: true,
    });
  } catch (error) {
    try {
      store.append({
        type: 'transaction',
        stage: 1.5,
        source: 'storefront',
        scenarioId,
        intent: route.intent,
        resolvedMerchantAccountId: route.account.merchantAccountId,
        paymentMethodType: 'paypal',
        amount,
        currency: route.intent.currency,
        outcome: 'gateway_error',
        request,
        error: { name: error?.name ?? 'Error', code: error?.code ?? null },
      });
    } catch {
      // Preserve the gateway failure as the primary error.
    }
    throw error;
  }

  const verification = verifyMerchantAccount(result, route.account.merchantAccountId);
  const response = summarizeGatewayResult(result);
  let auditPersisted = true;
  try {
    store.append({
      type: 'transaction',
      stage: 1.5,
      source: 'storefront',
      scenarioId,
      intent: route.intent,
      resolvedMerchantAccountId: route.account.merchantAccountId,
      responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
      verified: verification.passed,
      paymentMethodType: result?.transaction?.paymentInstrumentType ?? 'paypal',
      amount: result?.transaction?.amount ?? amount,
      currency: result?.transaction?.currencyIsoCode ?? route.intent.currency,
      outcome:
        result?.success === true && verification.passed
          ? 'succeeded'
          : result?.success === true
            ? 'route_mismatch'
            : 'failed',
      braintreeId: result?.transaction?.id ?? null,
      request,
      response,
      verification,
    });
  } catch (error) {
    auditPersisted = false;
    logger.error('Storefront transaction audit persistence error:', error?.name ?? 'Error');
  }

  return { result, verification, auditPersisted };
}

function sendRouteMismatch(res, verification) {
  return res.status(502).json({
    success: false,
    error: 'Braintree returned a different merchant account than the server selected',
    code: 'ROUTE_VERIFICATION_FAILED',
    verification,
  });
}

function createApiRouter({
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  gatewayClient,
  store = eventStore,
  logger = console,
} = {}) {
  const router = express.Router();
  const service = () => catalogService || getCatalogService();
  const gateway = () => gatewayClient || getGatewayClient();

  function routesOrProblem(res) {
    try {
      return getStorefrontRoutes(service());
    } catch (error) {
      sendProblem(
        res,
        503,
        'CATALOG_UNAVAILABLE',
        error.message || 'Merchant account discovery is unavailable.'
      );
      return null;
    }
  }

  router.use('/webhooks', webhookRouter);

  router.get('/client-token', async (req, res) => {
    const query = req.query || {};
    const unsupportedParameters = Object.keys(query).filter(
      (parameter) => parameter !== 'paymentType'
    );
    if (unsupportedParameters.length > 0) {
      return sendProblem(
        res,
        400,
        'INVALID_CLIENT_TOKEN_INTENT',
        'Only a paymentType intent may be supplied when requesting a client token.'
      );
    }

    const paymentType = query.paymentType ?? 'one_time';
    if (
      typeof paymentType !== 'string' ||
      !CLIENT_TOKEN_PAYMENT_TYPES.has(paymentType)
    ) {
      return sendProblem(
        res,
        400,
        'INVALID_PAYMENT_TYPE',
        'paymentType must be one_time or recurring.'
      );
    }

    const routes = routesOrProblem(res);
    if (!routes) return;
    const route = paymentType === 'recurring' ? routes.recurring : routes.oneTime;

    try {
      appendLegacyRouteEvent(
        store,
        route,
        `storefront-${paymentType}-client-token`,
        'client-token'
      );
      const clientToken = await gateway().generateClientToken({
        merchantAccountId: route.account.merchantAccountId,
      });
      return res.send(clientToken);
    } catch (error) {
      if (['CATALOG_UNAVAILABLE', 'UNKNOWN_MERCHANT_ACCOUNT'].includes(error?.code)) {
        return sendProblem(
          res,
          503,
          'CATALOG_UNAVAILABLE',
          'The storefront route is stale. Refresh merchant accounts before retrying.'
        );
      }
      logger.error('Error generating client token:', error?.name ?? 'Error');
      return sendProblem(res, 500, 'BRAINTREE_REQUEST_FAILED', 'Unable to generate a sandbox client token');
    }
  });

  router.post('/create-billing-plan', (req, res) => {
    const routes = routesOrProblem(res);
    if (!routes) return;
    const { type, description, frequency, installments } = req.body || {};
    const currency = routes.currency;
    const suppliedCurrency = req.body?.currency;
    if (suppliedCurrency && suppliedCurrency !== currency) {
      return sendProblem(res, 409, 'STOREFRONT_CURRENCY_MISMATCH', 'The storefront currency changed. Reload the page before checkout.');
    }

    const normalize = (value) => normalizeStorefrontAmount(value, currency);
    let planDetails;
    if (type === 'subscription' || type === 'recurring') {
      const amount = normalize(req.body?.amount);
      if (!amount || !FREQUENCY_MAP[frequency]) {
        return sendProblem(res, 400, 'INVALID_PLAN', 'The billing amount or frequency is invalid.');
      }
      planDetails = { description, amount, currency, currencyIsoCode: currency, frequency: FREQUENCY_MAP[frequency] };
    } else if (type === 'installments') {
      const amount = normalize(req.body?.amount);
      if (!amount || !FREQUENCY_MAP[frequency] || !Number.isInteger(Number(installments)) || Number(installments) <= 0) {
        return sendProblem(res, 400, 'INVALID_PLAN', 'The installment details are invalid.');
      }
      planDetails = { description, amount, currency, currencyIsoCode: currency, frequency: FREQUENCY_MAP[frequency], totalCycles: Number(installments) };
    } else if (type === 'hybrid') {
      const setupFee = normalize(req.body?.oneTimeAmount);
      const recurringAmount = normalize(req.body?.recurringAmount);
      if (!setupFee || !recurringAmount || !FREQUENCY_MAP[frequency]) {
        return sendProblem(res, 400, 'INVALID_PLAN', 'The bundle billing details are invalid.');
      }
      planDetails = { description, setupFee, recurringAmount, currency, currencyIsoCode: currency, frequency: FREQUENCY_MAP[frequency] };
    } else if (type === 'unscheduled') {
      const reloadAmount = normalize(req.body?.reloadAmount);
      const reloadThreshold = normalize(req.body?.reloadThreshold);
      if (!reloadAmount || !reloadThreshold) {
        return sendProblem(res, 400, 'INVALID_PLAN', 'The reload billing details are invalid.');
      }
      planDetails = { description, reloadAmount, reloadThreshold, currency, currencyIsoCode: currency };
    } else {
      return sendProblem(res, 400, 'INVALID_BILLING_TYPE', 'Invalid billing type');
    }

    return res.json({ success: true, planType: type, planDetails });
  });

  router.post('/create-transaction', async (req, res) => {
    const routes = routesOrProblem(res);
    if (!routes) return;
    if (req.body?.currency && req.body.currency !== routes.currency) {
      return sendProblem(res, 409, 'STOREFRONT_CURRENCY_MISMATCH', 'The storefront currency changed. Reload the page before checkout.');
    }
    const amount = normalizeStorefrontAmount(req.body?.amount, routes.currency);
    if (!amount) return sendProblem(res, 400, 'INVALID_AMOUNT', 'The payment amount is invalid for the storefront currency.');

    try {
      const sale = await executeLegacySale({
        gateway: gateway(),
        store,
        route: routes.oneTime,
        amount,
        nonce: req.body?.nonce,
        orderId: req.body?.description,
        scenarioId: `storefront-${routes.currency.toLowerCase()}-one-time`,
        logger,
      });
      if (!sale.result.success) return res.status(400).json({ success: false, error: sale.result.message });
      if (!sale.verification.passed) return sendRouteMismatch(res, sale.verification);
      return res.json({
        success: true,
        transactionId: sale.result.transaction.id,
        amount: sale.result.transaction.amount,
        currency: sale.result.transaction.currencyIsoCode || routes.currency,
        auditPersisted: sale.auditPersisted,
      });
    } catch (error) {
      logger.error('Error processing one-time transaction:', error?.name ?? 'Error');
      const code = ['CATALOG_UNAVAILABLE', 'UNKNOWN_MERCHANT_ACCOUNT'].includes(error?.code)
        ? 'CATALOG_UNAVAILABLE'
        : 'BRAINTREE_REQUEST_FAILED';
      return sendProblem(res, code === 'CATALOG_UNAVAILABLE' ? 503 : 500, code, 'Unable to process the sandbox transaction');
    }
  });

  router.post('/create-subscription', async (req, res) => {
    const routes = routesOrProblem(res);
    if (!routes) return;
    const billingData = req.body?.billingData || {};
    const plan = billingData.planDetails || {};
    if ((plan.currencyIsoCode || plan.currency) !== routes.currency) {
      return sendProblem(res, 409, 'STOREFRONT_CURRENCY_MISMATCH', 'The storefront currency changed. Reload the page before checkout.');
    }

    let amount;
    let message;
    if (billingData.type === 'subscription' || billingData.type === 'recurring' || billingData.type === 'installments') {
      amount = normalizeStorefrontAmount(plan.amount, routes.currency);
      message = billingData.type === 'installments'
        ? `First installment of ${formatCurrencyAmount(amount || '0', routes.currency)} processed`
        : `Initial payment of ${formatCurrencyAmount(amount || '0', routes.currency)} processed`;
    } else if (billingData.type === 'hybrid') {
      const setupFee = normalizeStorefrontAmount(plan.setupFee, routes.currency);
      const recurringAmount = normalizeStorefrontAmount(plan.recurringAmount, routes.currency);
      if (setupFee && recurringAmount) amount = addStorefrontAmounts(setupFee, recurringAmount, routes.currency);
      message = amount ? `Bundle payment of ${formatCurrencyAmount(amount, routes.currency)} processed` : '';
    } else if (billingData.type === 'unscheduled') {
      amount = normalizeStorefrontAmount(plan.reloadAmount, routes.currency);
      message = amount ? `First reload of ${formatCurrencyAmount(amount, routes.currency)} processed` : '';
    } else {
      return sendProblem(res, 400, 'UNKNOWN_BILLING_TYPE', 'Unknown billing type');
    }
    if (!amount) return sendProblem(res, 400, 'INVALID_AMOUNT', 'The billing amount is invalid for the storefront currency.');

    try {
      const sale = await executeLegacySale({
        gateway: gateway(),
        store,
        route: routes.recurring,
        amount,
        nonce: req.body?.nonce,
        scenarioId: `storefront-${routes.currency.toLowerCase()}-${billingData.type}`,
        logger,
      });
      if (!sale.result.success) return res.status(400).json({ success: false, error: sale.result.message });
      if (!sale.verification.passed) return sendRouteMismatch(res, sale.verification);
      return res.json({
        success: true,
        transactionId: sale.result.transaction.id,
        amount: sale.result.transaction.amount,
        currency: sale.result.transaction.currencyIsoCode || routes.currency,
        message,
        auditPersisted: sale.auditPersisted,
      });
    } catch (error) {
      logger.error('Error processing transaction:', error?.name ?? 'Error');
      const code = ['CATALOG_UNAVAILABLE', 'UNKNOWN_MERCHANT_ACCOUNT'].includes(error?.code)
        ? 'CATALOG_UNAVAILABLE'
        : 'BRAINTREE_REQUEST_FAILED';
      return sendProblem(res, code === 'CATALOG_UNAVAILABLE' ? 503 : 500, code, 'Unable to process the sandbox transaction');
    }
  });

  return router;
}

const router = createApiRouter();
router.createApiRouter = createApiRouter;
router.getStorefrontRoutes = getStorefrontRoutes;
router.normalizeStorefrontAmount = normalizeStorefrontAmount;

module.exports = router;
