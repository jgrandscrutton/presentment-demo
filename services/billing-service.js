const FREQUENCIES = {
  weekly: 'WEEK',
  monthly: 'MONTH',
  yearly: 'YEAR',
};

const BILLING_TYPES = new Set([
  'subscription',
  'recurring',
  'unscheduled',
  'installments',
  'hybrid',
]);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${fieldName} is required.`);
  }

  const normalized = value.trim();
  if (normalized.length > 255) {
    throw new ValidationError(`${fieldName} must not exceed 255 characters.`);
  }

  return normalized;
}

function normalizeAmount(value, fieldName = 'amount') {
  const rawAmount = typeof value === 'number' ? String(value) : value;
  if (typeof rawAmount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rawAmount)) {
    throw new ValidationError(`${fieldName} must be a decimal amount with at most two decimal places.`);
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999.99) {
    throw new ValidationError(`${fieldName} must be a positive number.`);
  }

  return amount.toFixed(2);
}

function normalizeFrequency(value) {
  const frequency = FREQUENCIES[value];

  if (!frequency) {
    throw new ValidationError('frequency must be weekly, monthly, or yearly.');
  }

  return frequency;
}

function buildBillingPlan(input, currency) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('billingData is required.');
  }

  const type = input.type;
  if (!BILLING_TYPES.has(type)) {
    throw new ValidationError('type is not a supported billing type.');
  }

  const description = requireText(input.description, 'description');
  const planDetails = {
    description,
    currencyIsoCode: currency,
  };

  if (type === 'subscription' || type === 'recurring') {
    planDetails.amount = normalizeAmount(input.amount);
    planDetails.frequency = normalizeFrequency(input.frequency);
  }

  if (type === 'unscheduled') {
    planDetails.reloadAmount = normalizeAmount(input.reloadAmount, 'reloadAmount');
    planDetails.reloadThreshold = normalizeAmount(input.reloadThreshold, 'reloadThreshold');
  }

  if (type === 'installments') {
    planDetails.amount = normalizeAmount(input.amount);
    planDetails.frequency = normalizeFrequency(input.frequency);

    const totalCycles = Number(input.installments);
    if (!Number.isInteger(totalCycles) || totalCycles < 2 || totalCycles > 36) {
      throw new ValidationError('installments must be an integer between 2 and 36.');
    }
    planDetails.totalCycles = totalCycles;
  }

  if (type === 'hybrid') {
    planDetails.setupFee = normalizeAmount(input.oneTimeAmount, 'oneTimeAmount');
    planDetails.recurringAmount = normalizeAmount(input.recurringAmount, 'recurringAmount');
    planDetails.frequency = normalizeFrequency(input.frequency);
  }

  return {
    type,
    description,
    planDetails,
  };
}

function getInitialCharge(billingPlan) {
  const { type, planDetails } = billingPlan;

  switch (type) {
    case 'subscription':
      return {
        amount: planDetails.amount,
        transactionSource: 'recurring_first',
        message: `First subscription payment processed in ${planDetails.currencyIsoCode}.`,
      };
    case 'recurring':
      return {
        amount: planDetails.amount,
        transactionSource: 'recurring_first',
        message: `Initial recurring payment processed in ${planDetails.currencyIsoCode}.`,
      };
    case 'installments':
      return {
        amount: planDetails.amount,
        transactionSource: 'installment_first',
        message: `First installment processed; ${planDetails.totalCycles - 1} remain.`,
      };
    case 'hybrid':
      return {
        amount: planDetails.setupFee,
        transactionSource: 'recurring_first',
        message: `One-time setup fee processed in ${planDetails.currencyIsoCode}.`,
      };
    case 'unscheduled':
      return {
        amount: planDetails.reloadAmount,
        transactionSource: 'unscheduled',
        message: `Initial reload processed in ${planDetails.currencyIsoCode}.`,
      };
    default:
      throw new ValidationError('type is not a supported billing type.');
  }
}

module.exports = {
  ValidationError,
  buildBillingPlan,
  getInitialCharge,
  normalizeAmount,
  requireText,
};
