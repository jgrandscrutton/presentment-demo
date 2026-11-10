const devices = require('../data/devices');
const { ValidationError, requireText } = require('./billing-service');

const BILLING_PRODUCTS = {
  'unlimited-data': {
    type: 'subscription',
    description: 'Unlimited Data Plan',
    amount: '35.00',
    frequency: 'monthly',
  },
  'pay-as-you-go': {
    type: 'recurring',
    description: 'Pay As You Go Plan',
    amount: '25.00',
    frequency: 'monthly',
  },
  'auto-reload': {
    type: 'unscheduled',
    description: 'Auto-Reload Prepaid Account',
    reloadAmount: '50.00',
    reloadThreshold: '10.00',
  },
  'phone-plan-bundle': {
    type: 'hybrid',
    description: 'iPhone 15 + Unlimited Plan Bundle',
    oneTimeAmount: '199.00',
    recurringAmount: '60.00',
    frequency: 'monthly',
  },
  'iphone-15-installments': {
    type: 'installments',
    description: 'iPhone 15 (24 monthly installments)',
    amount: '41.62',
    frequency: 'monthly',
    installments: 24,
  },
};

function billingProduct(productId) {
  const id = requireText(productId, 'productId');
  const product = BILLING_PRODUCTS[id];

  if (!product) {
    throw new ValidationError('Unknown billing product.');
  }

  return {
    productId: id,
    ...product,
  };
}

function oneTimePurchase(input) {
  const productId = requireText(input?.productId, 'productId');
  const device = devices.find(item => item.id === productId);
  if (!device) {
    throw new ValidationError('Unknown one-time product.');
  }

  const storageName = requireText(input.storage, 'storage');
  const storage = device.storage.find(option => option.size === storageName);
  if (!storage) {
    throw new ValidationError('The selected storage option is not available.');
  }

  const colour = requireText(input.colour, 'colour');
  if (!device.colours.includes(colour)) {
    throw new ValidationError('The selected colour is not available.');
  }

  return {
    productId,
    storage: storage.size,
    colour,
    description: `${device.brand} ${device.name} (${storage.size}, ${colour})`,
    amount: Number(storage.upfrontPrice).toFixed(2),
  };
}

module.exports = {
  billingProduct,
  oneTimePurchase,
};
