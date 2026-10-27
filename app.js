'use strict';

const cookieParser = require('cookie-parser');
const express = require('express');
const exphbs = require('express-handlebars');
const logger = require('morgan');
const path = require('node:path');

const { getRuntimeCatalogService } = require('./lib/catalog/runtime');
const apiRouter = require('./routes/api');
const basicRouter = require('./routes/basic');
const demoApiRouter = require('./routes/demo-api');
const demoLogRouter = require('./routes/demo-log');
const demoOperationsRouter = require('./routes/demo-operations');
const demoRouter = require('./routes/demo');
const storeRouter = require('./routes/store');

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
  app.use('/demo', routers.demo || demoRouter);
  app.use('/', routers.store || storeRouter);
  app.use('/basic', routers.basic || basicRouter);
  app.use(
    '/api/demo/transactions',
    routers.demoOperations || demoOperationsRouter
  );
  app.use('/api/demo', routers.demoApi || demoApiRouter);
  app.use('/api', routers.api || apiRouter);

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

  app.buildHealthStatus = () => buildHealthStatus(healthCatalog());
  return app;
}

const app = createApp();
app.createApp = createApp;
app.buildHealthStatusFor = buildHealthStatus;

module.exports = app;
