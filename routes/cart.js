const express = require('express');
const router = express.Router();
const { randomUUID } = require('node:crypto');
const { deviceItem, basketItems, total: basketTotal } = require('../services/storefront-quote');

router.get('/', (req, res) => {
  const cart = basketItems(req.session.cart);
  res.render('cart', { title: 'Your Basket', cart, total: basketTotal(cart), isEmpty: cart.length === 0, storefrontPayment: cart.length > 0 });
});

router.post('/add', (req, res) => {
  const { deviceId, storageIndex, colour } = req.body;
  let item;
  try { item = deviceItem({ deviceId, storageIndex, colour }); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }

  if (!req.session.cart) req.session.cart = [];

  const existing = req.session.cart.find(
    entry => entry.deviceId === deviceId && entry.size === item.size && entry.colour === item.colour
  );

  if (existing) {
    if (existing.quantity >= 10) return res.status(400).json({ error: 'You can add up to 10 of each device.' });
    existing.quantity += 1;
  } else {
    req.session.cart.push(item);
  }
  delete req.session.storefrontQuote;
  req.session.cartVersion = randomUUID();

  res.json({
    success: true,
    cartCount: req.session.cart.reduce((sum, item) => sum + item.quantity, 0),
  });
});

router.post('/update', (req, res) => {
  const { deviceId, size, colour, quantity } = req.body;
  const cart = req.session.cart || [];
  const item = cart.find(i => i.deviceId === deviceId && i.size === size && i.colour === colour);

  if (item) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 0 || qty > 10) return res.status(400).send('Choose a quantity between 0 and 10.');
    if (qty <= 0) {
      req.session.cart = cart.filter(i => !(i.deviceId === deviceId && i.size === size && i.colour === colour));
    } else {
      item.quantity = qty;
    }
  }
  delete req.session.storefrontQuote;
  req.session.cartVersion = randomUUID();
  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const { deviceId, size, colour } = req.body;
  req.session.cart = (req.session.cart || []).filter(
    i => !(i.deviceId === deviceId && i.size === size && i.colour === colour)
  );
  delete req.session.storefrontQuote;
  req.session.cartVersion = randomUUID();
  res.redirect('/cart');
});

module.exports = router;
