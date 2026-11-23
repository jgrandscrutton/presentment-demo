const devices = require('../data/devices');
const { allPlans } = require('../data/plans');

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function deviceItem(selection) {
  const device = devices.find(item => item.id === selection.deviceId);
  if (!device) invalid('Device not found.');
  const index = Number(selection.storageIndex ?? 0);
  if (!Number.isInteger(index) || !device.storage[index]) invalid('Choose a valid storage option.');
  const storage = device.storage[index];
  const colour = selection.colour || device.colours[0];
  if (!device.colours.includes(colour)) invalid('Choose a valid colour.');
  return {
    deviceId: device.id, brand: device.brand, name: device.name, emoji: device.emoji,
    size: storage.size, colour, upfrontPrice: storage.upfrontPrice, quantity: 1,
  };
}

function basketItems(cart = []) {
  return cart.map(item => {
    const device = devices.find(entry => entry.id === item.deviceId);
    const storageIndex = device?.storage.findIndex(storage => storage.size === item.size);
    const trusted = deviceItem({ deviceId: item.deviceId, storageIndex, colour: item.colour });
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) invalid('Choose a quantity between 1 and 10.');
    return { ...trusted, quantity: item.quantity };
  });
}

function total(items) {
  return (items.reduce((sum, item) => sum + Math.round(item.upfrontPrice * 100) * item.quantity, 0) / 100).toFixed(2);
}

function quote(selection, cart) {
  const kind = selection.kind;
  let items;
  let billing;
  if (kind === 'device') items = [deviceItem(selection)];
  else if (kind === 'cart') {
    items = basketItems(cart);
    if (!items.length) invalid('Your basket is empty.');
  } else if (kind === 'plan') {
    const plan = allPlans.find(item => item.id === selection.planId);
    if (!plan) invalid('Plan not found.');
    let amount;
    let cycles = 0;
    if (plan.type === 'fixed') {
      const contract = plan.contractLengths.find(item => item.id === (selection.contractLengthId || '1month'));
      if (!contract) invalid('Choose a valid contract length.');
      amount = +(plan.baseMonthlyPrice * (1 - contract.discountPct / 100)).toFixed(2);
      cycles = contract.months === 1 ? 0 : contract.months;
      billing = { type: 'SUBSCRIPTION', name: `${plan.name} — ${contract.label}`, amount, cycles };
    } else if (plan.subType === 'autotopup') {
      amount = Number(selection.topUpAmount ?? plan.defaultTopUp);
      const threshold = Number(selection.threshold ?? plan.defaultThreshold);
      if (!plan.topUpAmounts.includes(amount) || !plan.thresholds.includes(threshold)) invalid('Choose valid top-up and threshold amounts.');
      billing = { type: 'UNSCHEDULED', name: plan.name, amount, threshold };
    } else {
      amount = plan.typicalMonthlyAmount;
      billing = { type: 'RECURRING', name: plan.name, amount, cycles };
    }
    items = [{ name: `${plan.name} plan — initial payment`, emoji: plan.emoji, upfrontPrice: amount, quantity: 1 }];
  } else invalid('Choose a device, basket, or plan.');

  const amount = total(items);
  const description = items.map(item => `${item.quantity} × ${item.name}`).join(', ');
  const paymentOptions = billing ? {
    flow: 'vault', planType: billing.type,
    planMetadata: {
      name: billing.name, currencyIsoCode: 'GBP', totalAmount: amount,
      billingCycles: [{
        sequence: '1', trial: false,
        ...(billing.type === 'UNSCHEDULED' ? {} : { billingFrequency: '1', billingFrequencyUnit: 'MONTH', numberOfExecutions: String(billing.cycles), startDate: new Date().toISOString().slice(0, 10) }),
        pricingScheme: { pricingModel: billing.type === 'SUBSCRIPTION' ? 'FIXED' : billing.type === 'UNSCHEDULED' ? 'AUTO_RELOAD' : 'VARIABLE', price: amount, ...(billing.threshold ? { reloadThresholdAmount: billing.threshold.toFixed(2) } : {}) },
      }],
    },
  } : { flow: 'checkout', amount, currency: 'GBP', intent: 'capture', enableShippingAddress: true };
  return { kind, items, amount, currency: 'GBP', description, paymentOptions };
}

module.exports = { deviceItem, basketItems, total, quote };
