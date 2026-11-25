const { createPaymentStore } = require('../services/payment-store');
const { createBillingService } = require('../services/billing-service');
const gateway = require('./braintree');

const store = createPaymentStore();
const billing = createBillingService({ gateway, store });
module.exports = { store, billing };
