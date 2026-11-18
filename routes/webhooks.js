'use strict';

const express = require('express');

const { getGatewayClient } = require('../lib/braintree/gateway');
const eventStore = require('../lib/events/store');

const SUPPORTED_WEBHOOK_KINDS = new Set([
  'dispute_opened',
  'dispute_won',
  'dispute_lost',
  'subscription_charged_successfully',
  'subscription_charged_unsuccessfully',
  'subscription_went_past_due',
]);

const MAX_ACTIVITY_EVENTS = 50;
const WEBHOOK_BODY_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'parameters.too.many',
  'request.aborted',
  'request.size.invalid',
]);
const WEBHOOK_FORM_FIELDS = new Set(['bt_signature', 'bt_payload']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function safeString(value, maxLength = 300) {
  const resolved = nonEmptyString(value);
  return resolved ? resolved.slice(0, maxLength) : null;
}

function safeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function latestSubscriptionTransaction(subscription) {
  return Array.isArray(subscription?.transactions) && subscription.transactions.length > 0
    ? subscription.transactions[0]
    : null;
}

function summarizeWebhookNotification(notification) {
  const kind = safeString(notification?.kind, 120);
  const webhookTimestamp = safeDate(notification?.timestamp);

  if (kind?.startsWith('dispute_')) {
    const dispute = notification?.dispute || {};
    const transactionId = safeString(
      dispute?.transaction?.id || dispute?.transactionDetails?.id,
      300
    );
    return {
      kind,
      webhookTimestamp,
      entityType: 'dispute',
      entityId: safeString(dispute.id, 300),
      transactionId,
      dispute: {
        id: safeString(dispute.id, 300),
        status: safeString(dispute.status, 120),
        reason: safeString(dispute.reason, 120),
        kind: safeString(dispute.kind, 120),
        amount: safeString(dispute.amount, 80),
        currency: safeString(dispute.currencyIsoCode, 12)?.toUpperCase() || null,
        merchantAccountId: safeString(
          dispute.merchantAccountId || dispute?.transaction?.merchantAccountId,
          300
        ),
        transactionId,
        receivedDate: safeDate(dispute.receivedDate),
        replyByDate: safeDate(dispute.replyByDate),
      },
      subscription: null,
    };
  }

  const subscription = notification?.subscription || {};
  const transaction = latestSubscriptionTransaction(subscription);
  return {
    kind,
    webhookTimestamp,
    entityType: 'subscription',
    entityId: safeString(subscription.id, 300),
    transactionId: safeString(transaction?.id, 300),
    dispute: null,
    subscription: {
      id: safeString(subscription.id, 300),
      status: safeString(subscription.status, 120),
      planId: safeString(subscription.planId, 300),
      price: safeString(subscription.price, 80),
      balance: safeString(subscription.balance, 80),
      merchantAccountId: safeString(subscription.merchantAccountId, 300),
      nextBillingDate: safeDate(subscription.nextBillingDate),
      transaction: transaction
        ? {
            id: safeString(transaction.id, 300),
            status: safeString(transaction.status, 120),
            amount: safeString(transaction.amount, 80),
            currency: safeString(transaction.currencyIsoCode, 12)?.toUpperCase() || null,
            merchantAccountId: safeString(transaction.merchantAccountId, 300),
          }
        : null,
    },
  };
}

function isTrustedRootEvent(event, gatewayMerchantId) {
  if (!event || event.relatedEventId || event.verified !== true) return false;
  if (gatewayMerchantId && event.gatewayMerchantId !== gatewayMerchantId) return false;
  const resolved = nonEmptyString(event.resolvedMerchantAccountId);
  const returned = nonEmptyString(event.responseMerchantAccountId);
  return Boolean(resolved && returned && resolved === returned);
}

function rootEventCurrency(event) {
  return safeString(event?.currency || event?.intent?.currency, 12)?.toUpperCase() || null;
}

function findRelatedEvent(events, summary, gatewayMerchantId) {
  const candidates = [...events].reverse();

  if (summary.entityType === 'dispute' && summary.transactionId) {
    return candidates.find(
      (event) =>
        event.type === 'transaction' &&
        event.braintreeId === summary.transactionId &&
        isTrustedRootEvent(event, gatewayMerchantId) &&
        (!summary.dispute?.merchantAccountId ||
          summary.dispute.merchantAccountId === event.responseMerchantAccountId) &&
        (!summary.dispute?.currency ||
          summary.dispute.currency === rootEventCurrency(event))
    ) || null;
  }

  if (summary.entityType === 'subscription' && summary.entityId) {
    return candidates.find(
      (event) =>
        event.type === 'subscription' &&
        event.subscriptionId === summary.entityId &&
        isTrustedRootEvent(event, gatewayMerchantId) &&
        (!summary.subscription?.merchantAccountId ||
          summary.subscription.merchantAccountId === event.responseMerchantAccountId) &&
        (!summary.subscription?.transaction?.merchantAccountId ||
          summary.subscription.transaction.merchantAccountId ===
            event.responseMerchantAccountId) &&
        (!summary.subscription?.transaction?.currency ||
          summary.subscription.transaction.currency === rootEventCurrency(event))
    ) || null;
  }

  return null;
}

function sameWebhookIdentity(candidate, proposed) {
  if (
    candidate?.type !== 'webhook' ||
    proposed?.type !== 'webhook' ||
    candidate.gatewayMerchantId !== proposed.gatewayMerchantId ||
    candidate.webhookKind !== proposed.webhookKind ||
    candidate.webhookTimestamp !== proposed.webhookTimestamp
  ) {
    return false;
  }

  if (proposed.disputeId) return candidate.disputeId === proposed.disputeId;
  if (proposed.subscriptionId) {
    return candidate.subscriptionId === proposed.subscriptionId;
  }
  return false;
}

function outcomeFor(summary) {
  if (summary.kind === 'subscription_charged_successfully') return 'succeeded';
  if (summary.kind === 'subscription_charged_unsuccessfully') return 'failed';
  if (summary.kind === 'subscription_went_past_due') return 'past_due';
  return summary.dispute?.status || summary.kind?.replace(/^dispute_/, '') || 'received';
}

function appendWebhookEvent(store, summary, gatewayMerchantId) {
  const events = store.list();
  const related = findRelatedEvent(events, summary, gatewayMerchantId);
  const subscriptionStatus =
    summary.subscription?.status ||
    (summary.kind === 'subscription_went_past_due' ? 'past_due' : null);
  const amount =
    summary.dispute?.amount ||
    summary.subscription?.transaction?.amount ||
    summary.subscription?.price ||
    summary.subscription?.balance ||
    related?.amount ||
    null;
  const currency =
    summary.dispute?.currency ||
    summary.subscription?.transaction?.currency ||
    related?.currency ||
    related?.intent?.currency ||
    null;

  return store.appendIfAbsent({
    type: 'webhook',
    stage: 4,
    endpoint: 'braintree-webhook',
    scenarioId: `webhook-${summary.kind}`,
    webhookKind: summary.kind,
    webhookTimestamp: summary.webhookTimestamp,
    disputeId: summary.dispute?.id || null,
    disputeStatus: summary.dispute?.status || null,
    disputeReason: summary.dispute?.reason || null,
    subscriptionId: summary.subscription?.id || null,
    subscriptionStatus,
    braintreeId: summary.transactionId,
    relatedEventId: related?.id || null,
    resolvedMerchantAccountId: related?.resolvedMerchantAccountId || null,
    responseMerchantAccountId: related?.responseMerchantAccountId || null,
    verified: Boolean(related),
    amount,
    currency,
    outcome: outcomeFor(summary),
    request: {
      contentType: 'application/x-www-form-urlencoded',
      webhookKind: summary.kind,
    },
    response: summary,
  }, sameWebhookIdentity);
}

function activityEvent(event) {
  return {
    ...event,
    auditType: event.type,
    type: event.webhookKind,
    receivedAt: event.webhookTimestamp || event.timestamp,
    data: event.response,
  };
}

function normalizeStatus(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[ -]+/g, '_')
    : '';
}

function disputeActivityRows(events, gatewayMerchantId) {
  const currentGateway = nonEmptyString(gatewayMerchantId);
  if (!currentGateway || !Array.isArray(events)) return [];

  const seenDisputes = new Set();
  const rows = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (rows.length >= MAX_ACTIVITY_EVENTS) break;
    const event = events[index];
    const disputeId = nonEmptyString(event?.disputeId);
    const eventId = nonEmptyString(event?.id);
    if (
      event?.type !== 'webhook' ||
      event?.gatewayMerchantId !== currentGateway ||
      !disputeId ||
      !eventId ||
      seenDisputes.has(disputeId)
    ) {
      continue;
    }

    seenDisputes.add(disputeId);
    const disputeStatus = normalizeStatus(event.disputeStatus) || 'unknown';
    const linked = event.verified === true && nonEmptyString(event.relatedEventId) !== null;
    rows.push({
      eventId,
      receivedAt: safeString(event.webhookTimestamp || event.timestamp, 80),
      webhookKind: safeString(event.webhookKind, 120) || 'dispute',
      disputeId,
      disputeStatus,
      disputeReason: safeString(event.disputeReason, 300),
      transactionId: safeString(event.braintreeId, 300),
      merchantAccountId: safeString(
        event.responseMerchantAccountId || event.resolvedMerchantAccountId,
        300
      ),
      amount: safeString(event.amount, 80),
      currency: safeString(event.currency, 12)?.toUpperCase() || null,
      linked,
      actionable: linked && disputeStatus === 'open',
    });
  }
  return rows;
}

function isInvalidSignature(error) {
  const name = String(error?.name || error?.type || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return name.includes('invalidsignature') || code.includes('invalid_signature');
}

function safeError(error) {
  return {
    name: safeString(error?.name, 120) || 'Error',
    code: safeString(error?.code, 120),
  };
}

function createWebhookRouter({
  gatewayClient,
  store = eventStore,
  logger = console,
  includeActivity = true,
  getGatewayMerchantId = () => process.env.MERCHANT_ID,
} = {}) {
  if (
    !store ||
    typeof store.append !== 'function' ||
    typeof store.appendIfAbsent !== 'function' ||
    typeof store.list !== 'function'
  ) {
    throw new TypeError(
      'Webhook event store must provide append, appendIfAbsent, and list methods'
    );
  }
  if (typeof getGatewayMerchantId !== 'function') {
    throw new TypeError('getGatewayMerchantId must be a function');
  }

  const router = express.Router();
  const parseForm = express.urlencoded({ extended: false, limit: '1mb' });
  const gateway = () => gatewayClient || getGatewayClient();

  router.post(
    '/braintree',
    (req, res, next) => {
      if (!req.is('application/x-www-form-urlencoded')) {
        return res.status(415).json({
          success: false,
          code: 'UNSUPPORTED_WEBHOOK_MEDIA_TYPE',
          error: 'Braintree webhooks must use application/x-www-form-urlencoded.',
        });
      }
      return next();
    },
    parseForm,
    async (req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
      const fields = Object.keys(body);
      const hasUnexpectedField = fields.some((field) => !WEBHOOK_FORM_FIELDS.has(field));
      // Preserve the signed values byte-for-byte. Even harmless-looking
      // trimming would change what the SDK validates.
      const btSignature =
        typeof body.bt_signature === 'string' && body.bt_signature.trim() !== ''
          ? body.bt_signature
          : null;
      const btPayload =
        typeof body.bt_payload === 'string' && body.bt_payload.trim() !== ''
          ? body.bt_payload
          : null;

      if (
        hasUnexpectedField ||
        fields.length !== WEBHOOK_FORM_FIELDS.size ||
        !btSignature ||
        !btPayload
      ) {
        logger.warn?.('Rejected malformed Braintree webhook form.');
        return res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_FORM',
          error: 'The signed Braintree webhook fields are required.',
        });
      }

      let notification;
      try {
        notification = await gateway().parseWebhookNotification({
          btSignature,
          btPayload,
        });
      } catch (error) {
        logger.warn?.('Rejected Braintree webhook.', safeError(error));
        const invalidSignature = isInvalidSignature(error);
        return res.status(invalidSignature ? 400 : 502).json({
          success: false,
          code: invalidSignature ? 'INVALID_WEBHOOK_SIGNATURE' : 'WEBHOOK_PARSE_FAILED',
          error: invalidSignature
            ? 'The Braintree webhook signature is invalid.'
            : 'The Braintree webhook could not be parsed.',
        });
      }

      const summary = summarizeWebhookNotification(notification);
      if (!summary.kind || !SUPPORTED_WEBHOOK_KINDS.has(summary.kind)) {
        logger.info?.('Ignored unsupported Braintree webhook kind.', {
          kind: summary.kind || 'unknown',
        });
        return res.status(202).send('Ignored');
      }
      if (!summary.entityId || !summary.webhookTimestamp) {
        logger.warn?.('Rejected incomplete parsed Braintree webhook.', {
          kind: summary.kind,
        });
        return res.status(422).json({
          success: false,
          code: 'INCOMPLETE_WEBHOOK_NOTIFICATION',
          error: 'The parsed Braintree webhook is missing required event metadata.',
        });
      }

      try {
        appendWebhookEvent(
          store,
          summary,
          nonEmptyString(getGatewayMerchantId())
        );
      } catch (error) {
        logger.error?.('Could not persist Braintree webhook event.', safeError(error));
        return res.status(500).json({
          success: false,
          code: 'WEBHOOK_PERSISTENCE_FAILED',
          error: 'The Braintree webhook could not be saved and will be retried.',
        });
      }

      return res.status(200).send('OK');
    }
  );

  // Body-parser errors occur before the route handler can validate the two
  // signed fields. Keep that boundary JSON-only and never let Express render
  // an error page containing request diagnostics for the public receiver.
  router.use((error, req, res, next) => {
    if (!WEBHOOK_BODY_ERROR_TYPES.has(error?.type)) return next(error);

    const tooLarge = error.type === 'entity.too.large';
    logger.warn?.('Rejected malformed Braintree webhook body.', safeError(error));
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      code: tooLarge ? 'WEBHOOK_BODY_TOO_LARGE' : 'INVALID_WEBHOOK_BODY',
      error: tooLarge
        ? 'The Braintree webhook body exceeds the allowed size.'
        : 'The Braintree webhook body could not be parsed.',
    });
  });

  if (includeActivity) {
    router.get('/activity', (req, res) => {
      try {
        const allWebhookEvents = store.list().filter((event) => event.type === 'webhook');
        const events = allWebhookEvents
          .slice(-MAX_ACTIVITY_EVENTS)
          .reverse()
          .map(activityEvent);
        const disputes = disputeActivityRows(
          allWebhookEvents,
          nonEmptyString(getGatewayMerchantId())
        );
        return res.json({
          success: true,
          events,
          count: allWebhookEvents.length,
          disputes,
          disputeCount: disputes.length,
        });
      } catch (error) {
        logger.error?.('Could not read Braintree webhook activity.', safeError(error));
        return res.status(500).json({
          success: false,
          events: [],
          count: 0,
          disputes: [],
          disputeCount: 0,
          code: 'WEBHOOK_ACTIVITY_UNAVAILABLE',
          error: {
            code: 'WEBHOOK_ACTIVITY_UNAVAILABLE',
            message: 'Webhook activity is temporarily unavailable.',
          },
        });
      }
    });
  }

  return router;
}

const router = createWebhookRouter();
router.SUPPORTED_WEBHOOK_KINDS = SUPPORTED_WEBHOOK_KINDS;
router.appendWebhookEvent = appendWebhookEvent;
router.createWebhookRouter = createWebhookRouter;
router.disputeActivityRows = disputeActivityRows;
router.summarizeWebhookNotification = summarizeWebhookNotification;

module.exports = router;
