const express = require('express');
const router = express.Router();

function getCartSummary(req) {
  const cart = req.session.cart || [];
  const total = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
  return { cart, total, isEmpty: cart.length === 0 };
}

// Step 1: Account
router.get('/', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  const tab = req.query.tab || 'guest';
  res.render('checkout-account', { title: 'Checkout', cart, total, tab });
});

router.post('/account', (req, res) => {
  const { type, email, password, firstName, lastName, remember } = req.body;
  req.session.checkoutAccount = { type, email, firstName, lastName };
  res.redirect('/checkout/shipping');
});

// Step 2: Shipping
router.get('/shipping', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  if (!req.session.checkoutAccount) return res.redirect('/checkout');
  const shipping = req.session.checkoutShipping || {};
  res.render('checkout-shipping', { title: 'Shipping | Checkout', cart, total, shipping });
});

router.post('/shipping', (req, res) => {
  req.session.checkoutShipping = req.body;
  res.redirect('/checkout/payment');
});

// Step 3: Billing & Payment
router.get('/payment', (req, res) => {
  const { cart, total, isEmpty } = getCartSummary(req);
  if (isEmpty) return res.redirect('/cart');
  if (!req.session.checkoutShipping) return res.redirect('/checkout/shipping');
  const shipping = req.session.checkoutShipping || {};
  res.render('checkout-payment', { title: 'Payment | Checkout', cart, total, shipping });
});

router.post('/payment', (req, res) => {
  // Clear checkout session data after "placing" order
  const cart = req.session.cart || [];
  const total = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
  req.session.lastOrder = { cart, total, account: req.session.checkoutAccount, shipping: req.session.checkoutShipping };
  req.session.cart = [];
  delete req.session.checkoutAccount;
  delete req.session.checkoutShipping;
  res.redirect('/checkout/confirmation');
});

// Confirmation
router.get('/confirmation', (req, res) => {
  const order = req.session.lastOrder;
  if (!order) return res.redirect('/');
  res.render('checkout-confirmation', { title: 'Order Confirmed | Checkout', order });
});

module.exports = router;
