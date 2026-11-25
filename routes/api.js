const express = require('express');
const gateway = require('../config/braintree');
const router = express.Router();
router.use('/webhooks', require('./webhooks'));
router.get('/client-token', async (req, res) => {
  try { const result = await gateway.clientToken.generate({ ...(process.env.MERCHANT_ACCOUNT_ID ? { merchantAccountId: process.env.MERCHANT_ACCOUNT_ID } : {}) }); res.set('Cache-Control', 'no-store').send(result.clientToken); }
  catch { res.status(502).json({ error: 'Could not connect to Braintree.' }); }
});
// Retired endpoints collected only an initial payment and did not persist billing consent.
router.post(['/create-billing-plan', '/create-subscription', '/create-transaction'], (req, res) => {
  res.status(410).json({ error: 'Use the current storefront checkout or billing demo to create a persistent Braintree payment or billing agreement.' });
});
module.exports = router;
