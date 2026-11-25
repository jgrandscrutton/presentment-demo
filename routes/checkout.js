const express = require('express');
const router = express.Router();
const { basketItems, total: basketTotal } = require('../services/storefront-quote');
const { store } = require('../config/payment-runtime');

function getCartSummary(req) {
  const cart = basketItems(req.session.cart);
  const total = basketTotal(cart);
  return { cart, total, isEmpty: cart.length === 0 };
}

// Step 1: Account
router.get('/', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  res.render('checkout-account', { title: 'Checkout', cart, total, storefrontMessaging: true });
});

router.post('/account', (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).send('Enter a valid email address.');
  req.session.checkoutAccount = { type: 'guest', email };
  res.redirect('/checkout/shipping');
});

// Step 2: Shipping
router.get('/shipping', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  if (!req.session.checkoutAccount) return res.redirect('/checkout');
  const shipping = req.session.checkoutShipping || {};
  res.render('checkout-shipping', { title: 'Shipping | Checkout', cart, total, shipping, storefrontMessaging: true });
});

router.post('/shipping', (req, res) => {
  if (!req.session.checkoutAccount) return res.redirect('/checkout');
  const fields = ['firstName', 'lastName', 'line1', 'city', 'postcode', 'country'];
  if (fields.some(field => typeof req.body[field] !== 'string' || !req.body[field].trim())) return res.status(400).send('Complete the required shipping details.');
  if (!['GB', 'IE', 'US'].includes(req.body.country)) return res.status(400).send('Choose a supported delivery country.');
  req.session.checkoutShipping = Object.fromEntries([...fields, 'line2', 'phone'].map(field => [field, typeof req.body[field] === 'string' ? req.body[field].trim() : '']));
  delete req.session.storefrontQuote;
  res.redirect('/checkout/payment');
});

// Step 3: Billing & Payment
router.get('/payment', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  if (!req.session.checkoutShipping) return res.redirect('/checkout/shipping');
  const shipping = req.session.checkoutShipping || {};
  res.render('checkout-payment', { title: 'Payment | Checkout', cart, total, shipping, storefrontPayment: true });
});

router.post('/payment', (req, res) => {
  res.status(400).json({ error: 'Complete payment through Braintree before placing your order.' });
});

// Confirmation
router.get('/confirmation', (req, res) => {
  const order = req.session.lastOrder;
  if (!order) return res.redirect('/');
  const agreement = order.agreementId ? store.get('agreement', order.agreementId, req.session.billingOwner) : undefined;
  res.render('checkout-confirmation', { title: 'Order Confirmed | Checkout', order: { ...order, ...(agreement ? { billingStatus: agreement.status } : {}) } });
});

module.exports = router;
