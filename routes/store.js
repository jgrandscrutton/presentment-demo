const express = require('express');
const router = express.Router();
for (const [route, type] of Object.entries({ subscription: 'subscription', recurring: 'recurring', installments: 'installments', bundled: 'hybrid', unscheduled: 'unscheduled' })) {
  router.get(`/${route}`, (req, res) => res.redirect(`/basic?type=${type}`));
}
router.get('/success', (req, res) => res.redirect('/checkout/confirmation'));
router.get('/webhook-activity', (req, res) => res.render('webhook-activity', { title: 'Webhook Activity' }));
module.exports = router;
