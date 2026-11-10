const braintreeService = require('../services/braintree-service');
const webhookStore = require('../services/webhook-store');
const { ValidationError } = require('../services/billing-service');

function requireWebhookField(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${fieldName} is required.`);
  }

  return value;
}

function summarizeWebhookSubject(subject) {
  if (!subject || typeof subject !== 'object') {
    return {};
  }

  const summary = {};
  const topLevelFields = {};
  for (const field of ['id', 'status', 'type', 'amount', 'currencyIsoCode', 'orderId']) {
    if (['string', 'number', 'boolean'].includes(typeof subject[field])) {
      topLevelFields[field] = subject[field];
    }
  }
  if (Object.keys(topLevelFields).length > 0) {
    summary.subject = topLevelFields;
  }

  for (const [name, value] of Object.entries(subject)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const safeFields = {};
    for (const field of ['id', 'status', 'type', 'amount', 'currencyIsoCode', 'orderId']) {
      if (['string', 'number', 'boolean'].includes(typeof value[field])) {
        safeFields[field] = value[field];
      }
    }

    if (Object.keys(safeFields).length > 0) {
      summary[name] = safeFields;
    }
  }

  return summary;
}

async function receiveBraintreeWebhook(req, res, next) {
  try {
    const signature = requireWebhookField(req.body.bt_signature, 'bt_signature');
    const payload = requireWebhookField(req.body.bt_payload, 'bt_payload');
    const notification = await braintreeService.parseWebhookNotification(signature, payload);

    webhookStore.add({
      timestamp: notification.timestamp,
      type: notification.kind,
      data: summarizeWebhookSubject(notification.subject),
      receivedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }),
    });

    res.sendStatus(200);
  } catch (error) {
    if (error instanceof ValidationError) {
      next(error);
      return;
    }

    error.statusCode = 400;
    next(error);
  }
}

function listWebhookActivity(req, res) {
  const events = webhookStore.list();
  res.json({
    events,
    count: events.length,
  });
}

module.exports = {
  receiveBraintreeWebhook,
  listWebhookActivity,
};
