const devices = require('../data/devices');
const { allPlans } = require('../data/plans');
const { money } = require('./billing-schedule');

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
      billing = { type: 'subscription', name: `${plan.name} — ${contract.label}`, amountPence: Math.round(amount * 100), initialPence: Math.round(amount * 100), cycles, frequency: 'monthly' };
    } else if (plan.subType === 'autotopup') {
      amount = Number(selection.topUpAmount ?? plan.defaultTopUp);
      const threshold = Number(selection.threshold ?? plan.defaultThreshold);
      if (!plan.topUpAmounts.includes(amount) || !plan.thresholds.includes(threshold)) invalid('Choose valid top-up and threshold amounts.');
      if (threshold >= amount) invalid('Choose a threshold below the top-up amount.');
      billing = { type: 'unscheduled', name: plan.name, amountPence: Math.round(amount * 100), initialPence: Math.round(amount * 100), thresholdPence: Math.round(threshold * 100), cycles: 0 };
    } else {
      amount = 0;
      billing = { type: 'recurring', name: plan.name, amountPence: money(selection.monthlyLimit || plan.typicalMonthlyAmount), initialPence: 0, frequency: 'monthly', cycles: 0 };
    }
    billing.planId = plan.id;
    items = [{ name: `${plan.name} plan`, emoji: plan.emoji, upfrontPrice: amount, quantity: 1 }];
  } else invalid('Choose a device, basket, or plan.');

  const amount = total(items);
  const description = items.map(item => `${item.quantity} × ${item.name}`).join(', ');
  const paymentOptions = billing ? billingOptions(billing) : { flow: 'checkout', amount, currency: 'GBP', intent: 'capture', enableShippingAddress: true };
  return { kind, items, amount, currency: 'GBP', description, paymentOptions, billing, consentText: billing ? consentText(billing) : undefined };
}

function billingOptions(billing) {
  const amount = (billing.amountPence / 100).toFixed(2);
  const planType = billing.type === 'unscheduled' ? 'UNSCHEDULED' : billing.type === 'recurring' ? 'RECURRING' : 'SUBSCRIPTION';
  return {
    flow: 'vault', planType,
    planMetadata: {
      name: billing.name, currencyIsoCode: 'GBP',
      ...(billing.initialPence > 0 ? { totalAmount: (billing.initialPence / 100).toFixed(2) } : {}),
      ...(billing.setupPence ? { oneTimeFeeAmount: (billing.setupPence / 100).toFixed(2) } : {}),
      billingCycles: [{
        sequence: '1', trial: false,
        ...(planType === 'UNSCHEDULED' ? {} : { billingFrequency: '1', billingFrequencyUnit: billing.frequency === 'weekly' ? 'WEEK' : billing.frequency === 'yearly' ? 'YEAR' : 'MONTH', numberOfExecutions: String(billing.cycles), startDate: new Date().toISOString().slice(0, 10) }),
        pricingScheme: { pricingModel: planType === 'RECURRING' ? 'VARIABLE' : planType === 'UNSCHEDULED' ? 'AUTO_RELOAD' : 'FIXED', price: amount, ...(billing.thresholdPence ? { reloadThresholdAmount: (billing.thresholdPence / 100).toFixed(2) } : {}) },
      }],
    },
  };
}

function consentText(billing) {
  const amount = `£${(billing.amountPence / 100).toFixed(2)}`;
  if (billing.type === 'unscheduled') return `Pay ${amount} now and automatically top up by ${amount} whenever your balance falls below £${(billing.thresholdPence / 100).toFixed(2)}. You can cancel future top-ups from Billing.`;
  if (billing.type === 'recurring') return `No payment today. Save your payment method and pay for recorded usage ${billing.frequency}, up to ${amount} per billing period. You can cancel future charges from Billing.`;
  const limit = billing.cycles ? ` for ${billing.cycles - 1} further payment${billing.cycles === 2 ? '' : 's'}` : ' until cancelled';
  return `Pay £${(billing.initialPence / 100).toFixed(2)} now, then ${amount} ${billing.frequency}${limit}. Your payment method will be saved for these charges. Manage or cancel future payments from Billing.`;
}

function demoQuote(input) {
  const type = input.type;
  if (!['subscription', 'recurring', 'unscheduled', 'installments', 'hybrid'].includes(type)) invalid('Choose a billing type.');
  const frequency = input.frequency || 'monthly';
  if (!['weekly', 'monthly', 'yearly'].includes(frequency)) invalid('Choose a billing frequency.');
  const name = typeof input.description === 'string' ? input.description.trim().slice(0, 100) : '';
  if (!name) invalid('Enter a description.');
  const amountPence = money(type === 'unscheduled' ? input.reloadAmount : type === 'hybrid' ? input.recurringAmount : input.amount);
  const setupPence = type === 'hybrid' ? money(input.oneTimeAmount ?? input.setupFee ?? 0, { allowZero: true }) : 0;
  const thresholdPence = type === 'unscheduled' ? money(input.reloadThreshold) : 0;
  if (type === 'unscheduled' && thresholdPence >= amountPence) invalid('The threshold must be below the top-up amount.');
  const cycles = type === 'installments' ? Number(input.installments) : 0;
  if (type === 'installments' && (!Number.isInteger(cycles) || cycles < 2 || cycles > 60)) invalid('Choose between 2 and 60 installments.');
  const initialPence = type === 'recurring' ? 0 : amountPence + setupPence;
  const billing = { type, name, frequency, amountPence, setupPence, thresholdPence, cycles, initialPence };
  return {
    kind: 'plan', amount: (initialPence / 100).toFixed(2), currency: 'GBP', description: name, billing,
    items: [{ name, upfrontPrice: initialPence / 100, quantity: 1, emoji: '📱' }],
    paymentOptions: billingOptions(billing), consentText: consentText(billing),
  };
}

module.exports = { deviceItem, basketItems, total, quote, demoQuote, consentText };
