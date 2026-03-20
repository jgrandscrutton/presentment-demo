const express = require('express');
const router = express.Router();
const devices = require('../data/devices');

router.get('/', (req, res) => {
  const cart = req.session.cart || [];
  const total = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
  res.render('cart', { title: 'Your Basket', cart, total, isEmpty: cart.length === 0 });
});

router.post('/add', (req, res) => {
  const { deviceId, storageIndex, colour } = req.body;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const storage = device.storage[parseInt(storageIndex, 10)] || device.storage[0];
  const selectedColour = colour || device.colours[0];

  if (!req.session.cart) req.session.cart = [];

  const existing = req.session.cart.find(
    item => item.deviceId === deviceId && item.size === storage.size && item.colour === selectedColour
  );

  if (existing) {
    existing.quantity += 1;
  } else {
    req.session.cart.push({
      deviceId,
      brand: device.brand,
      name: device.name,
      emoji: device.emoji,
      size: storage.size,
      colour: selectedColour,
      upfrontPrice: storage.upfrontPrice,
      quantity: 1,
    });
  }

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
    const qty = parseInt(quantity, 10);
    if (qty <= 0) {
      req.session.cart = cart.filter(i => !(i.deviceId === deviceId && i.size === size && i.colour === colour));
    } else {
      item.quantity = qty;
    }
  }

  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const { deviceId, size, colour } = req.body;
  req.session.cart = (req.session.cart || []).filter(
    i => !(i.deviceId === deviceId && i.size === size && i.colour === colour)
  );
  res.redirect('/cart');
});

module.exports = router;
