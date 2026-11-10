const express = require('express');
const router = express.Router();
const webhookRouter = require('./webhooks');
const billingAgreementRouter = require('./billing-agreements');
const paymentController = require('../controllers/payment-controller');

router.use('/webhooks', webhookRouter);
router.use('/billing-agreements', billingAgreementRouter);

router.get('/client-token', paymentController.getClientToken);
router.post('/billing-plans/preview', paymentController.previewBillingPlan);
router.post('/demo/billing-plans/preview', paymentController.previewCustomBillingPlan);
router.post('/transactions/preview', paymentController.previewTransaction);
router.post('/transactions', paymentController.createTransaction);
router.post('/billing-transactions', paymentController.createBillingTransaction);
router.post('/demo/billing-transactions', paymentController.createCustomBillingTransaction);

module.exports = router;
