const { gateway, merchantAccountId, currency } = require('../config/braintree');

function merchantAccountOptions() {
  return merchantAccountId ? { merchantAccountId } : {};
}

async function generateClientToken() {
  const response = await gateway.clientToken.generate(merchantAccountOptions());
  return response.clientToken;
}

async function vaultPaymentMethod({ nonce, email }) {
  const result = await gateway.customer.create({
    ...(email ? { email } : {}),
    paymentMethodNonce: nonce,
  });

  if (!result.success) {
    return result;
  }

  const paymentMethod = result.customer.paymentMethods[0];
  if (!paymentMethod?.token) {
    await gateway.customer.delete(result.customer.id).catch(() => {});
    throw new Error('Braintree vaulted the customer without returning a payment method token.');
  }

  return {
    success: true,
    customerId: result.customer.id,
    paymentMethodToken: paymentMethod.token,
    email: paymentMethod.email || result.customer.email || email,
  };
}

async function deleteCustomer(customerId) {
  return gateway.customer.delete(customerId);
}

async function createTransaction({
  nonce,
  paymentMethodToken,
  amount,
  orderId,
  transactionSource,
}) {
  if (!nonce && !paymentMethodToken) {
    throw new Error('A Braintree nonce or vaulted payment method token is required.');
  }

  return gateway.transaction.sale({
    amount,
    ...(nonce ? { paymentMethodNonce: nonce } : { paymentMethodToken }),
    orderId,
    ...(transactionSource ? { transactionSource } : {}),
    ...merchantAccountOptions(),
    options: {
      submitForSettlement: true,
    },
  });
}

async function findTransaction(transactionId) {
  return gateway.transaction.find(transactionId);
}

function parseWebhookNotification(signature, payload) {
  return gateway.webhookNotification.parse(signature, payload);
}

module.exports = {
  currency,
  generateClientToken,
  vaultPaymentMethod,
  deleteCustomer,
  createTransaction,
  findTransaction,
  parseWebhookNotification,
};
