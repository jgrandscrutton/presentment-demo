const express = require('express');
const router = express.Router();
const devices = require('../data/devices');

const BASE_URL = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

// POST /paypal/create-order
// Body: { type: 'device', deviceId, storageIndex, colour }
//    or { type: 'cart' }
router.post('/create-order', async (req, res) => {
  try {
    const { type, deviceId, storageIndex, colour } = req.body;
    let items, itemTotal;

    if (type === 'device') {
      const device = devices.find(d => d.id === deviceId);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      const storage = device.storage[parseInt(storageIndex, 10)];
      if (!storage) return res.status(404).json({ error: 'Storage option not found' });
      itemTotal = storage.upfrontPrice;
      items = [{
        name: `${device.brand} ${device.name}`,
        description: `${storage.size} · ${colour || device.colours[0]}`,
        quantity: '1',
        unit_amount: { currency_code: 'GBP', value: itemTotal.toFixed(2) },
      }];
    } else if (type === 'cart') {
      const cart = req.session.cart || [];
      if (!cart.length) return res.status(400).json({ error: 'Cart is empty' });
      itemTotal = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
      items = cart.map(item => ({
        name: `${item.brand} ${item.name}`,
        description: `${item.size} · ${item.colour}`,
        quantity: String(item.quantity),
        unit_amount: { currency_code: 'GBP', value: item.upfrontPrice.toFixed(2) },
      }));
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const accessToken = await getAccessToken();
    const orderRes = await fetch(`${BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'GBP',
            value: itemTotal.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'GBP', value: itemTotal.toFixed(2) },
            },
          },
          items,
        }],
      }),
    });
    const order = await orderRes.json();
    res.json({ id: order.id });
  } catch (err) {
    console.error('PayPal create-order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// POST /paypal/capture-order
// Body: { orderID, type: 'device' | 'cart' }
router.post('/capture-order', async (req, res) => {
  try {
    const { orderID, type } = req.body;
    const accessToken = await getAccessToken();
    const captureRes = await fetch(`${BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    const data = await captureRes.json();

    if (data.status === 'COMPLETED') {
      if (type === 'cart') {
        const cart = req.session.cart || [];
        const total = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
        req.session.lastOrder = { cart, total, paypalOrderId: data.id };
        req.session.cart = [];
      }
      res.json({ success: true, orderID: data.id });
    } else {
      res.status(400).json({ error: 'Payment not completed', status: data.status });
    }
  } catch (err) {
    console.error('PayPal capture-order error:', err);
    res.status(500).json({ error: 'Failed to capture payment' });
  }
});

module.exports = router;
