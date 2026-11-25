const express = require('express');
const { createHash } = require('node:crypto');
const gateway = require('../config/braintree');
const { billing, store } = require('../config/payment-runtime');
const router = express.Router();
router.post('/braintree', async (req, res) => {
  if (typeof req.body.bt_signature !== 'string' || typeof req.body.bt_payload !== 'string') return res.status(400).send('A signed Braintree notification is required.');
  let notification;
  try { notification = await gateway.webhookNotification.parse(req.body.bt_signature, req.body.bt_payload); }
  catch { return res.status(400).send('Invalid Braintree signature.'); }
  const id = createHash('sha256').update(req.body.bt_payload).digest('hex');
  const operation = `webhook:${id}`;
  if (store.operation(operation)?.state === 'succeeded') return res.sendStatus(200);
  if (!store.claim(operation, true)) return res.sendStatus(503);
  try {
    await billing.webhook(notification);
    const timestamp = new Date(notification.timestamp || Date.now()).toISOString();
    store.put('webhook', id, '', { id, type: notification.kind, timestamp, receivedAt: new Date(timestamp).toLocaleString('en-GB', { timeZone: 'Europe/London' }), data: { verified: true, kind: notification.kind } });
    store.finish(operation, 'succeeded');
    res.sendStatus(200);
  } catch { store.finish(operation, 'declined'); res.sendStatus(503); }
});
router.post('/paypal', (req, res) => res.status(410).send('Send signed Braintree notifications to /api/webhooks/braintree.'));
router.get('/activity', (req, res) => {
  const events = store.list('webhook').sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, 50);
  res.set('Cache-Control', 'no-store').json({ events, count: events.length });
});
module.exports = router;
