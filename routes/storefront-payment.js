const express = require('express');
const { randomUUID } = require('node:crypto');
const { quote, demoQuote } = require('../services/storefront-quote');
const { createPaymentStore } = require('../services/payment-store');
const { createBillingService } = require('../services/billing-service');

module.exports = function createStorefrontPaymentRouter(gateway, options = {}) {
  const store = options.store || createPaymentStore(':memory:');
  const billing = options.billing || createBillingService({ gateway, store });
  const router = express.Router();
  router.use((req, res, next) => {
    req.session.billingOwner ||= randomUUID();
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.post('/quote', (req, res) => {
    try {
      const selected = req.body.kind === 'demo' ? demoQuote(req.body) : quote(req.body, req.session.cart);
      if (selected.kind === 'cart') req.session.cartVersion ||= randomUUID();
      const prepared = {
        ...selected, id: randomUUID(), createdAt: Date.now(),
        account: req.session.checkoutAccount,
        shipping: req.session.checkoutShipping,
        cartFingerprint: selected.kind === 'cart' ? JSON.stringify(req.session.cart || []) : undefined,
        cartVersion: selected.kind === 'cart' ? req.session.cartVersion : undefined,
      };
      store.put('quote', prepared.id, req.session.billingOwner, prepared);
      req.session.storefrontQuote = prepared;
      const shipping = req.session.checkoutShipping;
      res.json({
        id: prepared.id, amount: prepared.amount, currency: prepared.currency,
        paymentOptions: prepared.paymentOptions, consentText: prepared.consentText,
        email: req.session.checkoutAccount?.email,
        billingAddress: shipping ? { givenName: shipping.firstName, surname: shipping.lastName, streetAddress: shipping.line1, extendedAddress: shipping.line2, locality: shipping.city, postalCode: shipping.postcode, countryCodeAlpha2: shipping.country } : undefined,
      });
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not prepare your payment.' }); }
  });
  router.get('/client-token', async (req, res) => {
    try {
      const account = await billing.merchantAccount();
      const customer = store.get('customer', req.session.billingOwner, req.session.billingOwner);
      const result = await gateway.clientToken.generate({ merchantAccountId: account.id, ...(customer?.ready ? { customerId: customer.id } : {}) });
      res.json({ clientToken: result.clientToken, googleMerchantId: process.env.GOOGLE_PAY_MERCHANT_ID || undefined, environment: 'TEST' });
    } catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : 'Could not connect to Braintree. Check your sandbox credentials and try again.' }); }
  });
  router.post('/pay', async (req, res) => {
    try {
      const owner = req.session.billingOwner;
      const { quoteId } = req.body;
      const prepared = typeof quoteId === 'string' ? store.get('quote', quoteId, owner) : undefined;
      if (!prepared) return res.status(409).json({ error: 'Your checkout has changed or expired. Refresh the page and try again.' });
      let receipt = store.get('receipt', quoteId, owner);
      if (!receipt) {
        if (Date.now() - prepared.createdAt > 30 * 60 * 1000 || (prepared.kind === 'cart' && (prepared.cartVersion !== req.session.cartVersion || prepared.cartFingerprint !== JSON.stringify(req.session.cart || [])))) return res.status(409).json({ error: 'Your checkout has changed or expired. Refresh the page and try again.' });
        const email = req.body.email || req.session.checkoutAccount?.email;
        if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({ error: 'Enter a valid email address.' });
        receipt = await billing.checkout({ prepared, owner, nonce: req.body.nonce, savedMethodId: req.body.savedMethodId, billingConsent: req.body.billingConsent === true, savePaymentMethod: req.body.savePaymentMethod === true, email });
      }
      await new Promise((resolve, reject) => req.session.reload(error => error ? reject(error) : resolve()));
      req.session.lastOrder = receipt;
      if (prepared.kind === 'cart' && req.session.cartVersion === prepared.cartVersion) {
        req.session.cart = [];
        delete req.session.cartVersion;
        delete req.session.checkoutAccount;
        delete req.session.checkoutShipping;
      }
      delete req.session.storefrontQuote;
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
      res.json({ success: true, redirect: '/checkout/confirmation', billingStatus: receipt.billingStatus });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.status ? error.message : 'Braintree could not complete checkout. Check Billing before retrying.' });
    }
  });
  return router;
};
