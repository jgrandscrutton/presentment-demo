'use strict';

const express = require('express');
const { getMerchantAccounts } = require('../config/merchant-accounts');
const currency = require('../lib/currency');
const { buildStorefrontViewModel } = require('./store');

function createBasicRouter({
  getAccounts = getMerchantAccounts,
  currencyTools = currency,
} = {}) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      res.render('basic', {
        title: 'Recurring Billing',
        layout: 'main',
        ...buildStorefrontViewModel({
          accounts: getAccounts(),
          currencyTools,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

const router = createBasicRouter();

module.exports = router;
module.exports.createBasicRouter = createBasicRouter;
