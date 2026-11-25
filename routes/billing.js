const express = require('express');
const { randomUUID } = require('node:crypto');

module.exports = function createBillingRouter({ billing, store }) {
  const router = express.Router();
  router.use((req, res, next) => {
    req.session.billingOwner ||= randomUUID();
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = action => async (req, res) => {
    try { const result = await action(req, req.session.billingOwner); res.json(result || { success: true }); }
    catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : 'Braintree could not complete this billing action.' }); }
  };
  router.get('/', handle((req, owner) => billing.summary(owner)));
  router.post('/agreements/:id/cancel', handle((req, owner) => billing.cancel(owner, req.params.id)));
  router.post('/agreements/:id/retry', handle((req, owner) => billing.retry(owner, req.params.id)));
  router.post('/agreements/:id/usage', handle((req, owner) => billing.recordUsage(owner, req.params.id, req.body)));
  router.post('/agreements/:id/payment-method', handle((req, owner) => billing.changeMethod(owner, req.params.id, req.body.methodId)));
  router.post('/payment-methods/:id/nonce', handle((req, owner) => billing.savedNonce(owner, req.params.id)));
  router.post('/payment-methods/:id/remove', handle((req, owner) => billing.removeMethod(owner, req.params.id)));
  router.get('/receipt/:id', handle((req, owner) => {
    const receipt = store.get('receipt', req.params.id, owner);
    if (!receipt) throw Object.assign(new Error('Receipt not found.'), { status: 404 });
    return receipt;
  }));
  return router;
};
