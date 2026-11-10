const braintree = require('braintree');
const environment = require('./environment');

environment.assertBraintreeConfiguration();

const gatewayEnvironment = environment.braintree.environment === 'production'
  ? braintree.Environment.Production
  : braintree.Environment.Sandbox;

const gateway = new braintree.BraintreeGateway({
  environment: gatewayEnvironment,
  merchantId: environment.braintree.merchantId,
  publicKey: environment.braintree.publicKey,
  privateKey: environment.braintree.privateKey,
});

module.exports = {
  gateway,
  merchantAccountId: environment.braintree.merchantAccountId,
  currency: environment.braintree.currency,
};
