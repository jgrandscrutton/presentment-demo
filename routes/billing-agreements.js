const express = require('express');
const requireBillingAdmin = require('../middleware/require-billing-admin');
const controller = require('../controllers/billing-agreement-controller');

const router = express.Router();

router.use(requireBillingAdmin);
router.get('/', controller.list);
router.post('/run-due', controller.runDue);
router.get('/:id', controller.get);
router.post('/:id/pause', controller.pause);
router.post('/:id/resume', controller.resume);
router.post('/:id/cancel', controller.cancel);
router.patch('/:id/amount', controller.updateAmount);
router.post('/:id/charge', controller.charge);
router.post('/:id/usage', controller.recordUsage);
router.post('/:id/resolve-review', controller.resolveReview);

module.exports = router;
