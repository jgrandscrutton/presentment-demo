'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cancelSubscription,
  createSubscription,
  createVerifiedTransaction,
  describePendingGatewayMutations,
} = require('../scripts/verify-stage3-sandbox');

function decision(paymentType = 'recurring') {
  return {
    matched: true,
    intent: { currency: 'USD', paymentType },
    account: {
      merchantAccountId: paymentType === 'recurring'
        ? 'account-usd-recurring'
        : 'account-usd-sale',
      currency: 'USD',
    },
  };
}

function recordingAppender() {
  const events = [];
  return {
    events,
    appendEvent(event) {
      const stored = structuredClone({
        ...event,
        id: `event-${events.length + 1}`,
      });
      events.push(stored);
      return stored;
    },
  };
}

const plan = Object.freeze({
  id: 'plan-usd',
  currency: 'USD',
  price: '12.00',
});

const vault = Object.freeze({
  customerId: 'demo-verifier-customer',
  paymentMethod: { token: 'server-only-token' },
  event: { id: 'vault-event' },
});

test('verifier follow-up transactions persist their root relationship', async () => {
  const audit = recordingAppender();
  const recurringDecision = decision('recurring');
  const result = await createVerifiedTransaction({
    gateway: {
      async createSale(request) {
        return {
          success: true,
          transaction: {
            id: 'transaction-next',
            status: 'submitted_for_settlement',
            amount: request.amount,
            currencyIsoCode: 'USD',
            merchantAccountId: request.merchantAccountId,
            paymentInstrumentType: 'credit_card',
          },
        };
      },
    },
    decision: recurringDecision,
    customerId: vault.customerId,
    vaultEventId: vault.event.id,
    scenarioId: 'verify-usd-recurring-next',
    amount: '11.00',
    transactionSource: 'recurring',
    recurringModel: 'merchant_managed',
    billingCycle: 'subsequent',
    orderId: 'stage3-next',
    label: 'USD subsequent recurring transaction',
    relatedEventId: 'first-cycle-event',
    appendEvent: audit.appendEvent,
  });

  assert.equal(result.event.relatedEventId, 'first-cycle-event');
  assert.equal(result.event.outcome, 'succeeded');
  assert.equal(describePendingGatewayMutations(), null);
});

test('definitive subscription validation failure is audited without an ambiguity warning', async () => {
  const audit = recordingAppender();

  await assert.rejects(
    () => createSubscription({
      gateway: {
        async createSubscription() {
          return { success: false, message: 'Plan is invalid.' };
        },
      },
      decision: decision('recurring'),
      plan,
      vault,
      scenarioId: 'verify-usd-subscription',
      appendEvent: audit.appendEvent,
    }),
    /rejected the subscription creation request/
  );

  const event = audit.events.find((candidate) => candidate.type === 'subscription');
  assert.equal(event.outcome, 'failed');
  assert.equal(event.subscriptionId, null);
  assert.equal(describePendingGatewayMutations(), null);
});

test('unconfirmed subscription cancellation is recorded as failed', async () => {
  const audit = recordingAppender();

  await assert.rejects(
    () => cancelSubscription({
      gateway: {
        async cancelSubscription(request) {
          return {
            success: true,
            subscription: {
              id: request.subscriptionId,
              merchantAccountId: request.merchantAccountId,
              planId: plan.id,
              status: 'Active',
              price: plan.price,
              transactions: [],
            },
          };
        },
      },
      decision: decision('recurring'),
      root: {
        id: 'subscription-1',
        event: { id: 'subscription-event', scenarioId: 'verify-usd-subscription' },
      },
      plan,
      customerId: vault.customerId,
      appendEvent: audit.appendEvent,
    }),
    /unexpected status Active/
  );

  const event = audit.events.find(
    (candidate) => candidate.type === 'subscription_action'
  );
  assert.equal(event.action, 'cancel');
  assert.equal(event.outcome, 'failed');
  assert.equal(event.relatedEventId, 'subscription-event');
  assert.equal(describePendingGatewayMutations(), null);
});
