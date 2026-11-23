const express = require('express');
const { randomUUID } = require('node:crypto');
const { quote } = require('../services/storefront-quote');

module.exports = function createStorefrontPaymentRouter(gateway) {
  const router = express.Router();
  const inFlight = new Set();
  let merchantAccountPromise;

  function merchantAccount() {
    if (!merchantAccountPromise) {
      merchantAccountPromise = (async () => {
        const account = process.env.MERCHANT_ACCOUNT_ID
          ? await gateway.merchantAccount.find(process.env.MERCHANT_ACCOUNT_ID)
          : (await new Promise((resolve, reject) => gateway.merchantAccount.all((error, accounts) => error ? reject(error) : resolve(accounts)))).find(item => item.default);
        if (!account || account.currencyIsoCode !== 'GBP') {
          const error = new Error('This storefront charges in GBP. Set MERCHANT_ACCOUNT_ID in .env to a GBP Braintree merchant account.');
          error.status = 503;
          throw error;
        }
        return account;
      })().catch(error => { merchantAccountPromise = undefined; throw error; });
    }
    return merchantAccountPromise;
  }

  router.post('/quote', (req, res) => {
    try {
      const prepared = { ...quote(req.body, req.session.cart), id: randomUUID(), createdAt: Date.now() };
      req.session.storefrontQuote = prepared;
      const shipping = req.session.checkoutShipping;
      res.json({
        id: prepared.id, amount: prepared.amount, currency: prepared.currency,
        paymentOptions: prepared.paymentOptions,
        email: req.session.checkoutAccount?.email,
        billingAddress: shipping ? { givenName: shipping.firstName, surname: shipping.lastName, streetAddress: shipping.line1, extendedAddress: shipping.line2, locality: shipping.city, postalCode: shipping.postcode, countryCodeAlpha2: shipping.country } : undefined,
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not prepare your payment.' });
    }
  });

  router.get('/client-token', async (req, res) => {
    try {
      const account = await merchantAccount();
      const result = await gateway.clientToken.generate({ merchantAccountId: account.id });
      res.set('Cache-Control', 'no-store').json({ clientToken: result.clientToken });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.status ? error.message : 'Could not connect to Braintree. Check your sandbox credentials and try again.' });
    }
  });

  router.post('/pay', async (req, res) => {
    const { nonce, quoteId } = req.body;
    if (req.session.lastOrder?.quoteId === quoteId && quoteId) return res.json({ success: true, redirect: '/checkout/confirmation' });
    const prepared = req.session.storefrontQuote;
    if (!prepared || prepared.id !== quoteId || Date.now() - prepared.createdAt > 30 * 60 * 1000) return res.status(409).json({ error: 'Your checkout has changed or expired. Refresh the page and try again.' });
    if (typeof nonce !== 'string' || !nonce.trim()) return res.status(400).json({ error: 'Approve a payment method before placing your order.' });
    if (inFlight.has(quoteId)) return res.status(409).json({ error: 'Your payment is already being processed.' });
    inFlight.add(quoteId);
    try {
      const account = await merchantAccount();
      const paymentMethod = await gateway.paymentMethodNonce.find(nonce);
      const card = paymentMethod.type === 'CreditCard';
      if (!['CreditCard', 'PayPalAccount'].includes(paymentMethod.type)) return res.status(400).json({ error: 'Choose PayPal or a supported card.' });
      if (card && !paymentMethod.threeDSecureInfo?.liabilityShifted) return res.status(400).json({ error: 'Card authentication was not completed. Please try again.' });
      const result = await gateway.transaction.sale({
        amount: prepared.amount,
        paymentMethodNonce: nonce,
        merchantAccountId: account.id,
        orderId: prepared.id,
        ...(req.session.checkoutAccount?.email ? { customer: { email: req.session.checkoutAccount.email } } : {}),
        options: { submitForSettlement: true, ...(card ? { threeDSecure: { required: true } } : {}) },
      });
      if (!result.success) return res.status(400).json({ error: result.message || 'Payment was declined. Choose another payment method.' });
      req.session.lastOrder = {
        quoteId: prepared.id, cart: prepared.items, total: prepared.amount,
        transactionId: result.transaction.id,
        account: req.session.checkoutAccount,
        shipping: req.session.checkoutShipping,
      };
      if (prepared.kind === 'cart') {
        req.session.cart = [];
        delete req.session.checkoutAccount;
        delete req.session.checkoutShipping;
      }
      delete req.session.storefrontQuote;
      const saved = await new Promise(resolve => req.session.save(error => resolve(!error)));
      if (!saved) return res.status(500).json({ error: 'Payment succeeded, but the receipt could not be saved. Please keep your Braintree transaction reference.', transactionId: result.transaction.id });
      res.json({ success: true, redirect: '/checkout/confirmation' });
    } catch {
      res.status(502).json({ error: 'Braintree could not complete the payment. Check the payment status before trying again.' });
    } finally {
      inFlight.delete(quoteId);
    }
  });
  return router;
};
