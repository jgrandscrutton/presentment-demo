const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook-controller');

router.post('/braintree', webhookController.receiveBraintreeWebhook);
router.get('/activity', webhookController.listWebhookActivity);

module.exports = router;
