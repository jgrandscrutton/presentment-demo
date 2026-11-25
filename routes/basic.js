const express = require('express');
const router = express.Router();
router.get('/', (req, res) => {
  const type = ['subscription', 'recurring', 'unscheduled', 'installments', 'hybrid'].includes(req.query.type) ? req.query.type : 'subscription';
  res.render('basic', { title: 'Braintree billing demo', storefrontPayment: true, initialBillingType: type });
});
module.exports = router;
