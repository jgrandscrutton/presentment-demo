'use strict';

const cookieParser = require('cookie-parser');
const express = require('express');
const exphbs = require('express-handlebars');
const logger = require('morgan');
const path = require('node:path');
const environment = require('./config/environment');

const { getRuntimeCatalogService } = require('./lib/catalog/runtime');
// Storefront gateway configuration is needed only when its API is used.
const apiRouter = (req, res, next) => require('./routes/api')(req, res, next);
const basicRouter = require('./routes/basic');
const demoApiRouter = require('./routes/demo-api');
const demoDisputesRouter = require('./routes/demo-disputes');
const demoLogRouter = require('./routes/demo-log');
const demoPreflightRouter = require('./routes/demo-preflight');
const demoRoutesRouter = require('./routes/demo-routes');
const demoOperationsRouter = require('./routes/demo-operations');
const demoRecurringApiRouter = require('./routes/demo-recurring-api');
const demoRouter = require('./routes/demo');
const storeRouter = require('./routes/store');
const { createWebhookRouter } = require('./routes/demo-webhooks');
const storefrontWebhookStore = require('./services/webhook-store');

function buildHealthStatus(catalogService = getRuntimeCatalogService()) {
  const state = catalogService.getState();
  const accounts = state.status === 'ok' && Array.isArray(state.accounts)
    ? state.accounts
    : [];

  return {
    status: 'up',
    environment: 'sandbox',
    checks: {
      server: 'up',
      merchantAccountDiscovery: state.status,
      braintreeConnectivity: 'not_checked',
    },
    gatewayMerchantId: state.gatewayMerchantId || null,
    discoveredAt: state.discoveredAt || null,
    configuredMerchantAccounts: accounts.length,
    activeMerchantAccounts: accounts.filter((account) => account.status === 'active').length,
    currencies: [...new Set(accounts.map((account) => account.currency))].sort(),
  };
}

function createApp({
  catalogService,
  routers = {},
  requestLogger = logger('dev'),
} = {}) {
  const app = express();
  const healthCatalog = () => catalogService || getRuntimeCatalogService();
  const currencyPart = new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: environment.braintree.currency, currencyDisplay: 'narrowSymbol',
  }).formatToParts(0).find((part) => part.type === 'currency');
  app.locals.currency = environment.braintree.currency;
  app.locals.currencySymbol = currencyPart?.value || environment.braintree.currency;

  app.set('views', path.join(__dirname, 'views'));
  app.engine('hbs', exphbs.engine({
    extname: '.hbs',
    defaultLayout: 'store',
    helpers: {
      eq: (a, b) => a === b,
      gt: (a, b) => a > b,
    },
  }));
  app.set('view engine', 'hbs');

  if (requestLogger) app.use(requestLogger);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json(buildHealthStatus(healthCatalog()));
  });

  app.use('/demo/log', routers.demoLog || demoLogRouter);
  app.use('/demo/disputes', routers.demoDisputes || demoDisputesRouter);
  app.use('/demo/preflight', routers.demoPreflight || demoPreflightRouter);
  app.use('/demo/routes', routers.demoRoutes || demoRoutesRouter);
  app.use('/demo', routers.demo || demoRouter);
  app.use('/', routers.store || storeRouter);
  app.use('/basic', routers.basic || basicRouter);
  app.use(
    '/api/demo/transactions',
    routers.demoOperations || demoOperationsRouter
  );
  app.use(
    '/api/demo/recurring',
    routers.demoRecurringApi || demoRecurringApiRouter
  );
  app.use('/api/demo', routers.demoApi || demoApiRouter);
  const webhookActivity = createWebhookRouter({
    getAdditionalActivity: () => storefrontWebhookStore.list(),
  });
  app.use('/api/webhooks', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/activity') return webhookActivity(req, res, next);
    return next();
  });
  app.use('/api', routers.api || apiRouter);

  app.use((req, res) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      return res.status(404).json({ success: false, error: 'API endpoint not found.' });
    }
    return res.status(404).send('Page not found.');
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.code === 'CATALOG_UNAVAILABLE') {
      if (req.path.startsWith('/api/')) {
        return res.status(503).json({
          success: false,
          error: {
            code: 'CATALOG_UNAVAILABLE',
            message: 'Gateway unavailable. Refresh merchant accounts before continuing.',
          },
        });
      }
      return res
        .status(503)
        .type('text/plain')
        .send('Gateway unavailable. Refresh merchant accounts from the routing demo.');
    }
    return next(error);
  });

  app.use((error, req, res, _next) => {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ success: false,
      error: status >= 500 ? 'Braintree request failed.' : error.message });
  });

  app.buildHealthStatus = () => buildHealthStatus(healthCatalog());
  return app;
}

const app = createApp();
app.createApp = createApp;
app.buildHealthStatusFor = buildHealthStatus;

module.exports = app;
