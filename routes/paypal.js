const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const devices = require('../data/devices');
const { allPlans, contractLengths } = require('../data/plans');

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

// POST /paypal/create-setup-token  (v3 Vault)
// Body: { planId, contractLengthId? }
// contractLengthId is required for fixed plans; omit for variable PAYG
router.post('/create-setup-token', async (req, res) => {
  try {
    const { planId, contractLengthId } = req.body;

    const plan = allPlans.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const accessToken = await getAccessToken();
    const baseUrl     = `${req.protocol}://${req.get('host')}`;
    const startDate   = new Date().toISOString().split('T')[0];

    let billingPlan;

    if (plan.subType === 'variable') {
      const typicalAmount = String(plan.typicalMonthlyAmount.toFixed(2));
      billingPlan = {
        name: 'PhonePal',
        product: {
          description: `${plan.name} Plan`,
          quantity: '1',
        },
        billing_cycles: [{
          tenure_type: 'REGULAR',
          pricing_scheme: {
            pricing_model: 'VARIABLE',
            price: { value: typicalAmount, currency_code: 'GBP' },
          },
          frequency: { interval_unit: 'MONTH', interval_count: '1' },
          total_cycles: '1',
          start_date: startDate,
        }],
        one_time_charges: {
          product_price: { value: typicalAmount, currency_code: 'GBP' },
          total_amount:  { value: typicalAmount, currency_code: 'GBP' },
        },
      };
    } else {
      const contract = contractLengths.find(c => c.id === contractLengthId);
      if (!contract) return res.status(400).json({ error: 'Invalid contract' });

      const price      = +(plan.baseMonthlyPrice * (1 - contract.discountPct / 100)).toFixed(2);
      const totalCycles = contract.months === 1 ? 0 : contract.months;

      billingPlan = {
        name: 'PhonePal',
        product: {
          description: `${plan.name} Plan — ${contract.label}`,
          quantity: '1',
        },
        one_time_charges: {
          product_price: { value: String(price), currency_code: 'GBP' },
          total_amount:  { value: String(price), currency_code: 'GBP' },
        },
        billing_cycles: [{
          tenure_type: 'REGULAR',
          pricing_scheme: {
            pricing_model: 'FIXED',
            price: { value: String(price), currency_code: 'GBP' },
          },
          frequency: { interval_unit: 'MONTH', interval_count: '1' },
          total_cycles: String(totalCycles),
          start_date: startDate,
        }],
      };
    }

    const payload = {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          usage_pattern: plan.subType === 'variable' ? 'RECURRING_POSTPAID' : 'SUBSCRIPTION_POSTPAID',
          billing_plan: billingPlan,
          experience_context: {
            shipping_preference: 'NO_SHIPPING',
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            brand_name: 'PhonePal',
            locale: 'en-GB',
            return_url: `${baseUrl}/plans`,
            cancel_url: `${baseUrl}/plans`,
          },
        },
      },
    };
    console.log('Payload', JSON.stringify(payload));
    const response = await fetch(`${BASE_URL}/v3/vault/setup-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('PayPal setup-token API error:', JSON.stringify(data, null, 2));
      return res.status(502).json({ error: 'PayPal API error', details: data });
    }

    res.json({ id: data.id });
  } catch (err) {
    console.error('PayPal create-setup-token error:', err);
    res.status(500).json({ error: 'Failed to create setup token' });
  }
});

// POST /paypal/save-payment-token  (v3 Vault)
// Exchanges an approved setup token for a reusable payment token.
// Body: { vaultSetupToken }
router.post('/save-payment-token', async (req, res) => {
  try {
    const { vaultSetupToken } = req.body;
    const accessToken = await getAccessToken();

    const response = await fetch(`${BASE_URL}/v3/vault/payment-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': randomUUID(),
      },
      body: JSON.stringify({
        payment_source: {
          token: { id: vaultSetupToken, type: 'SETUP_TOKEN' },
        },
      }),
    });
    const data = await response.json();
    // data.id is the reusable payment token — store against the customer record in production
    res.json({ success: true, paymentTokenId: data.id });
  } catch (err) {
    console.error('PayPal save-payment-token error:', err);
    res.status(500).json({ error: 'Failed to save payment token' });
  }
});

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
