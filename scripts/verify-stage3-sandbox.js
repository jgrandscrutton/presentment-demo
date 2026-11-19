'use strict';

const crypto = require('node:crypto');

const dotenv = require('dotenv');

dotenv.config({ path: ['./config.env', '.env'], quiet: true });

const { configureCatalogService } = require('../config/merchant-accounts');
const {
  getConfiguredMerchantId,
  getGateway,
  getGatewayClient,
} = require('../lib/braintree/gateway');
const {
  summarizeGatewayResult,
  summarizeSubscription,
  summarizeVaultResult,
  verifyMerchantAccount,
  verifySubscriptionRoute,
  verifyVaultResult,
} = require('../lib/braintree/result');
const { createCatalogService } = require('../lib/catalog/service');
const { getVerificationAmount } = require('../lib/currency');
const { append: appendStoredEvent } = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const { resolveRoute } = require('../lib/routing/resolve-route');

const SOURCE = 'verify:stage3:sandbox';
const pendingGatewayMutations = new Set();
const sensitiveRuntimeValues = new Set(['fake-valid-nonce']);

for (const name of ['MERCHANT_ID', 'PUBLIC_KEY', 'PRIVATE_KEY', 'BRAINTREE_MERCHANT_ID', 'BRAINTREE_PUBLIC_KEY', 'BRAINTREE_PRIVATE_KEY']) {
  const value = process.env[name];
  if (typeof value === 'string' && value.trim() !== '') {
    sensitiveRuntimeValues.add(value);
  }
}

function safeRuntimeText(value) {
  let safe = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of sensitiveRuntimeValues) {
    safe = safe.split(secret).join('[REDACTED]');
  }
  return redact(safe);
}

function beginGatewayMutation(details, operation) {
  const pending = { ...details };
  pendingGatewayMutations.add(pending);

  return Promise.resolve()
    .then(operation)
    .then((result) => {
      pending.braintreeId =
        result?.transaction?.id ??
        result?.subscription?.id ??
        result?.id ??
        pending.braintreeId ??
        null;
      return { pending, result };
    });
}

function appendAuditedMutation(
  pending,
  event,
  { outcomeKnown = true, appendEvent = appendStoredEvent } = {}
) {
  let stored;
  try {
    stored = appendEvent(event);
  } catch (error) {
    throw new Error(
      `Braintree may have completed ${pending.label}, but its Stage 3 audit event ` +
      'could not be saved. Do not repeat this operation until the Sandbox Control Panel has been checked.',
      { cause: error }
    );
  }

  if (outcomeKnown) pendingGatewayMutations.delete(pending);
  return stored;
}

function describePendingGatewayMutations() {
  if (pendingGatewayMutations.size === 0) return null;

  const operations = [...pendingGatewayMutations].map((pending) => {
    const identity = pending.braintreeId
      ? ` Braintree ID: ${pending.braintreeId}.`
      : pending.reference
        ? ` Reference: ${pending.reference}.`
        : '';
    return `${pending.label}.${identity}`;
  });

  return (
    'One or more requests may have reached Braintree without a complete local audit: ' +
    `${operations.join(' ')} Inspect them in the Sandbox Control Panel before rerunning.`
  );
}

function appendRouteEvent({
  decision,
  scenarioId,
  amount = null,
  appendEvent = appendStoredEvent,
}) {
  return appendEvent({
    type: 'route_resolution',
    stage: 3,
    source: SOURCE,
    scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    paymentMethodType: 'credit_card',
    amount,
    currency: decision.intent.currency,
    outcome: 'matched',
    route: decision,
  });
}

function resultMessage(summary, fallback) {
  return typeof summary?.message === 'string' && summary.message.trim() !== ''
    ? summary.message
    : fallback;
}

function findVaultedPaymentMethod(result) {
  const customer = result?.customer;
  const methods = [
    ...(Array.isArray(customer?.creditCards) ? customer.creditCards : []),
    ...(Array.isArray(customer?.paymentMethods) ? customer.paymentMethods : []),
  ].filter((method) => method && typeof method === 'object');
  const method = methods.find((candidate) => candidate.default === true) || methods[0];

  if (typeof method?.token !== 'string' || method.token.trim() === '') {
    throw new Error('Braintree did not return a reusable payment method for the verified customer.');
  }

  sensitiveRuntimeValues.add(method.token);
  return method;
}

function requireSuccessfulTransaction(result, decision, label) {
  const summary = summarizeGatewayResult(result);
  if (result?.success !== true || !result?.transaction) {
    throw new Error(
      `${label} failed: ${resultMessage(summary, 'Braintree returned no successful transaction.')}`
    );
  }

  const routeVerification = verifyMerchantAccount(
    result,
    decision.account.merchantAccountId
  );
  if (!routeVerification.passed) {
    throw new Error(
      `${label} route mismatch: expected ${routeVerification.expectedMerchantAccountId}, ` +
      `received ${routeVerification.actualMerchantAccountId || 'no merchant account ID'}.`
    );
  }

  if (result.transaction.currencyIsoCode !== decision.intent.currency) {
    throw new Error(
      `${label} currency mismatch: expected ${decision.intent.currency}, ` +
      `received ${result.transaction.currencyIsoCode || 'no currency'}.`
    );
  }

  return { routeVerification, summary };
}

function sharedVaultCandidates(accounts, plans) {
  const currencies = [...new Set(accounts.map((account) => account.currency))];
  const planCurrencies = new Set(plans.map((plan) => plan.currency));

  return currencies
    .map((currency) => {
      const recurring = resolveRoute({ currency, paymentType: 'recurring' }, accounts);
      const oneTime = resolveRoute({ currency, paymentType: 'one_time' }, accounts);
      if (!recurring.matched || !oneTime.matched) return null;

      return {
        currency,
        recurring,
        oneTime,
        split:
          recurring.account.merchantAccountId !== oneTime.account.merchantAccountId,
        hasPlan: planCurrencies.has(currency),
        isDefault: Boolean(
          recurring.account.isDefault || oneTime.account.isDefault
        ),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftScore = (left.split ? 100 : 0) + (left.hasPlan ? 10 : 0) +
        (left.isDefault ? 1 : 0);
      const rightScore = (right.split ? 100 : 0) + (right.hasPlan ? 10 : 0) +
        (right.isDefault ? 1 : 0);
      return rightScore - leftScore || left.currency.localeCompare(right.currency);
    });
}

function selectSubscriptionPlan(plans, accounts, preferredCurrency) {
  return plans
    .map((plan) => ({
      plan,
      decision: resolveRoute(
        { currency: plan.currency, paymentType: 'recurring' },
        accounts
      ),
    }))
    .filter((candidate) => candidate.decision.matched)
    .sort((left, right) => {
      const leftPreferred = left.plan.currency === preferredCurrency ? 1 : 0;
      const rightPreferred = right.plan.currency === preferredCurrency ? 1 : 0;
      return rightPreferred - leftPreferred || left.plan.id.localeCompare(right.plan.id);
    })[0] || null;
}

async function createVerifiedVault({
  gateway,
  decision,
  customerId,
  scenarioId,
  appendEvent = appendStoredEvent,
}) {
  appendRouteEvent({ decision, scenarioId, appendEvent });
  const mutation = await beginGatewayMutation({
    label: 'verified customer creation',
    reference: `customer ${customerId}`,
  }, () => gateway.createVaultedCustomer({
    customerId,
    paymentMethodNonce: 'fake-valid-nonce',
    merchantAccountId: decision.account.merchantAccountId,
  }));

  const summary = summarizeVaultResult(mutation.result);
  const verification = verifyVaultResult(mutation.result, decision.account);
  const event = appendAuditedMutation(mutation.pending, {
    type: 'vault',
    stage: 3,
    source: SOURCE,
    scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: verification.actualMerchantAccountId,
    verified: verification.passed,
    paymentMethodType: 'credit_card',
    amount: summary.verification?.amount ?? null,
    currency: verification.actualCurrency ?? decision.intent.currency,
    outcome: mutation.result?.success === true && verification.passed
      ? 'succeeded'
      : 'failed',
    customerId,
    request: {
      customerId,
      verifyCard: true,
      verificationMerchantAccountId: decision.account.merchantAccountId,
    },
    response: summary,
    verification,
  }, { appendEvent });

  if (mutation.result?.success !== true) {
    throw new Error(
      `Vault creation failed: ${resultMessage(summary, 'Braintree rejected the customer.')}`
    );
  }
  if (!verification.passed) {
    throw new Error(
      'Vault verification did not return verified status on the resolved merchant account and currency.'
    );
  }

  return {
    customerId,
    event,
    paymentMethod: findVaultedPaymentMethod(mutation.result),
    summary,
    verification,
  };
}

async function createVerifiedTransaction({
  gateway,
  decision,
  customerId,
  vaultEventId,
  scenarioId,
  amount,
  transactionSource,
  recurringModel,
  billingCycle,
  orderId,
  label,
  relatedEventId = null,
  appendEvent = appendStoredEvent,
}) {
  appendRouteEvent({ decision, scenarioId, amount, appendEvent });
  const mutation = await beginGatewayMutation({
    label,
    reference: `order ${orderId}`,
  }, () => gateway.createSale({
    merchantAccountId: decision.account.merchantAccountId,
    amount,
    customerId,
    orderId,
    submitForSettlement: true,
    ...(transactionSource ? { transactionSource } : {}),
  }));

  const summary = summarizeGatewayResult(mutation.result);
  const routeVerification = verifyMerchantAccount(
    mutation.result,
    decision.account.merchantAccountId
  );
  const currencyMatched =
    mutation.result?.transaction?.currencyIsoCode === decision.intent.currency;
  const verified = routeVerification.passed && currencyMatched;
  const event = appendAuditedMutation(mutation.pending, {
    type: 'transaction',
    stage: 3,
    source: SOURCE,
    scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId:
      mutation.result?.transaction?.merchantAccountId ?? null,
    verified,
    paymentMethodType:
      mutation.result?.transaction?.paymentInstrumentType ?? 'credit_card',
    amount: mutation.result?.transaction?.amount ?? amount,
    currency:
      mutation.result?.transaction?.currencyIsoCode ?? decision.intent.currency,
    outcome: mutation.result?.success === true && verified ? 'succeeded' : 'failed',
    transactionStatus: mutation.result?.transaction?.status ?? null,
    transactionSource: transactionSource ?? null,
    recurringModel,
    billingCycle,
    customerId,
    vaultEventId,
    braintreeId: mutation.result?.transaction?.id ?? null,
    relatedEventId,
    request: {
      customerId,
      submitForSettlement: true,
      ...(transactionSource ? { transactionSource } : {}),
    },
    response: summary,
    verification: {
      ...routeVerification,
      currencyMatched,
      expectedCurrency: decision.intent.currency,
      actualCurrency: mutation.result?.transaction?.currencyIsoCode ?? null,
    },
  }, { appendEvent });

  requireSuccessfulTransaction(mutation.result, decision, label);
  return { event, result: mutation.result };
}

function requireSubscriptionRoute(subscriptionOrResult, decision, label) {
  const summary = summarizeSubscription(subscriptionOrResult);
  const verification = verifySubscriptionRoute(subscriptionOrResult, decision.account);
  if (!summary) {
    throw new Error(`${label} did not return a subscription.`);
  }
  if (!verification.passed) {
    throw new Error(
      `${label} route mismatch: expected ${verification.expectedMerchantAccountId}, ` +
      `received ${verification.actualMerchantAccountId || 'no merchant account ID'}.`
    );
  }
  return { summary, verification };
}

async function createSubscription({
  gateway,
  decision,
  plan,
  vault,
  scenarioId,
  onSubscriptionIdentified = () => {},
  appendEvent = appendStoredEvent,
}) {
  appendRouteEvent({ decision, scenarioId, amount: plan.price, appendEvent });
  const mutation = await beginGatewayMutation({
    label: 'subscription creation',
    reference: `plan ${plan.id}, customer ${vault.customerId}`,
  }, () => gateway.createSubscription({
    merchantAccountId: decision.account.merchantAccountId,
    paymentMethodToken: vault.paymentMethod.token,
    planId: plan.id,
  }));

  const summary = summarizeSubscription(mutation.result);
  if (summary?.id) {
    mutation.pending.braintreeId = summary.id;
    onSubscriptionIdentified(summary.id);
  }
  const verification = verifySubscriptionRoute(mutation.result, decision.account);
  const planMatched = summary?.planId === plan.id;
  const event = appendAuditedMutation(mutation.pending, {
    type: 'subscription',
    stage: 3,
    source: SOURCE,
    scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: summary?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: 'credit_card',
    amount: summary?.price ?? plan.price,
    currency: plan.currency,
    outcome: mutation.result?.success === true && verification.passed && planMatched
      ? 'succeeded'
      : 'failed',
    recurringModel: 'braintree_subscription',
    customerId: vault.customerId,
    vaultEventId: vault.event.id,
    planId: plan.id,
    subscriptionId: summary?.id ?? null,
    subscriptionStatus: summary?.status ?? null,
    nextBillingDate: summary?.nextBillingDate ?? null,
    request: {
      planId: plan.id,
      customerId: vault.customerId,
      merchantAccountId: decision.account.merchantAccountId,
    },
    response: summary,
    verification: {
      ...verification,
      planMatched,
      expectedPlanId: plan.id,
      actualPlanId: summary?.planId ?? null,
    },
  }, {
    outcomeKnown: mutation.result?.success === false || Boolean(summary?.id),
    appendEvent,
  });

  if (mutation.result?.success !== true) {
    throw new Error('Braintree rejected the subscription creation request.');
  }
  if (!summary) {
    throw new Error('Subscription creation did not return a subscription.');
  }
  if (!verification.passed) {
    throw new Error(
      `Subscription creation route mismatch: expected ${verification.expectedMerchantAccountId}, ` +
      `received ${verification.actualMerchantAccountId || 'no merchant account ID'}.`
    );
  }
  if (summary.planId !== plan.id) {
    throw new Error(
      `Subscription creation returned plan ${summary.planId || 'none'}, expected ${plan.id}.`
    );
  }

  return { event, id: summary.id, summary, verification };
}

async function viewSubscription({
  gateway,
  decision,
  root,
  plan,
  customerId,
  appendEvent = appendStoredEvent,
}) {
  const subscription = await gateway.findSubscription({
    subscriptionId: root.id,
    merchantAccountId: decision.account.merchantAccountId,
  });
  const { summary, verification } = requireSubscriptionRoute(
    subscription,
    decision,
    'Subscription lookup'
  );
  appendEvent({
    type: 'subscription_action',
    action: 'view',
    stage: 3,
    source: SOURCE,
    scenarioId: root.event?.scenarioId ?? root.scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: summary.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: 'credit_card',
    amount: summary.price ?? plan.price,
    currency: plan.currency,
    outcome: 'succeeded',
    recurringModel: 'braintree_subscription',
    customerId,
    planId: plan.id,
    subscriptionId: root.id,
    subscriptionStatus: summary.status ?? null,
    nextBillingDate: summary.nextBillingDate ?? null,
    relatedEventId: root.event?.id ?? null,
    response: summary,
    verification,
  });
  return summary;
}

async function cancelSubscription({
  gateway,
  decision,
  root,
  plan,
  customerId,
  appendEvent = appendStoredEvent,
}) {
  const mutation = await beginGatewayMutation({
    label: 'subscription cancellation',
    reference: `subscription ${root.id}`,
    braintreeId: root.id,
  }, () => gateway.cancelSubscription({
    subscriptionId: root.id,
    merchantAccountId: decision.account.merchantAccountId,
  }));
  const summary = summarizeSubscription(mutation.result);
  const verification = verifySubscriptionRoute(mutation.result, decision.account);
  const cancellationConfirmed = String(summary?.status || '').toLowerCase() === 'canceled';
  appendAuditedMutation(mutation.pending, {
    type: 'subscription_action',
    action: 'cancel',
    stage: 3,
    source: SOURCE,
    scenarioId: root.event?.scenarioId ?? root.scenarioId,
    intent: decision.intent,
    resolvedMerchantAccountId: decision.account.merchantAccountId,
    responseMerchantAccountId: summary?.merchantAccountId ?? null,
    verified: verification.passed,
    paymentMethodType: 'credit_card',
    amount: summary?.price ?? plan.price,
    currency: plan.currency,
    outcome: mutation.result?.success === true && verification.passed && cancellationConfirmed
      ? 'succeeded'
      : 'failed',
    recurringModel: 'braintree_subscription',
    customerId,
    planId: plan.id,
    subscriptionId: root.id,
    subscriptionStatus: summary?.status ?? null,
    nextBillingDate: summary?.nextBillingDate ?? null,
    relatedEventId: root.event?.id ?? null,
    response: summary,
    verification,
  }, {
    outcomeKnown: mutation.result?.success === false || Boolean(summary),
    appendEvent,
  });

  if (mutation.result?.success !== true) {
    throw new Error('Braintree rejected the subscription cancellation request.');
  }
  if (!summary) {
    throw new Error('Subscription cancellation did not return a subscription.');
  }
  if (!verification.passed) {
    throw new Error(
      `Subscription cancellation route mismatch: expected ${verification.expectedMerchantAccountId}, ` +
      `received ${verification.actualMerchantAccountId || 'no merchant account ID'}.`
    );
  }
  if (!cancellationConfirmed) {
    throw new Error(
      `Subscription cancellation returned unexpected status ${summary.status || 'none'}.`
    );
  }
  return summary;
}

async function verifyStage3Sandbox() {
  const merchantId = getConfiguredMerchantId();
  const rawGateway = getGateway();
  const catalogService = createCatalogService({
    gateway: rawGateway,
    merchantId,
    environment: 'sandbox',
  });
  configureCatalogService(catalogService);

  const state = await catalogService.refresh();
  if (state.status !== 'ok') {
    throw new Error(
      `Merchant account discovery failed: ${state.error?.message || 'no usable catalog was returned'}`
    );
  }

  console.log('Discovered Braintree Sandbox recurring configuration:');
  console.table(state.accounts.map((account) => ({
    merchantAccountId: account.merchantAccountId,
    currency: account.currency,
    status: account.status,
    routes: account.paymentTypes.join(', ') || 'unassigned',
  })));

  if (state.planDiscovery.status === 'ok' && state.plans.length > 0) {
    console.log('Discovered compatible subscription plans:');
    console.table(state.plans.map((plan) => ({
      planId: plan.id,
      currency: plan.currency,
      price: plan.price,
      billingFrequency: plan.billingFrequency,
      trial: plan.trialPeriod ? 'yes' : 'no',
    })));
  } else if (state.planDiscovery.status === 'ok') {
    console.log('Model B: SKIPPED — no compatible Braintree subscription plan is available.');
  } else {
    console.log(
      'Model B: SKIPPED — subscription plan discovery is unavailable; ' +
      'merchant-managed recurring verification will continue.'
    );
  }

  for (const warning of state.warnings) {
    console.warn(`Catalog warning [${warning.code}]: ${warning.message}`);
  }

  const accounts = catalogService.getMerchantAccounts();
  const plans = catalogService.getPlans();
  const sharedCandidates = sharedVaultCandidates(accounts, plans);
  if (sharedCandidates.length === 0) {
    throw new Error(
      'No currency has both an active one-time route and an active recurring route.'
    );
  }

  const subsequentCandidate =
    sharedCandidates.find((candidate) => candidate.split) ||
    sharedCandidates[0];
  const gateway = getGatewayClient();
  const runTag = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const rows = [];
  const verifiedFlows = new Map();

  for (const [index, candidate] of sharedCandidates.entries()) {
    const currencySlug = candidate.currency.toLowerCase();
    const customerId = `demo-stage3-${currencySlug}-${runTag}`;
    const variant = 300 + (index * 10);
    const vault = await createVerifiedVault({
      gateway,
      decision: candidate.recurring,
      customerId,
      scenarioId: `verify-${currencySlug}-vault`,
    });

    const firstAmount = getVerificationAmount(candidate.currency, variant);
    const first = await createVerifiedTransaction({
      gateway,
      decision: candidate.recurring,
      customerId,
      vaultEventId: vault.event.id,
      scenarioId: `verify-${currencySlug}-recurring-first`,
      amount: firstAmount,
      transactionSource: 'recurring_first',
      recurringModel: 'merchant_managed',
      billingCycle: 'first',
      orderId: `stage3-${runTag}-${currencySlug}-first`,
      label: `${candidate.currency} first merchant-managed recurring transaction`,
    });

    let next = null;
    if (candidate.currency === subsequentCandidate.currency) {
      const nextAmount = getVerificationAmount(candidate.currency, variant + 1);
      next = await createVerifiedTransaction({
        gateway,
        decision: candidate.recurring,
        customerId,
        vaultEventId: vault.event.id,
        scenarioId: `verify-${currencySlug}-recurring-next`,
        amount: nextAmount,
        transactionSource: 'recurring',
        recurringModel: 'merchant_managed',
        billingCycle: 'subsequent',
        relatedEventId: first.event.id,
        orderId: `stage3-${runTag}-${currencySlug}-next`,
        label: `${candidate.currency} subsequent merchant-managed recurring transaction`,
      });
    }

    const oneTimeAmount = getVerificationAmount(candidate.currency, variant + 2);
    const oneTime = await createVerifiedTransaction({
      gateway,
      decision: candidate.oneTime,
      customerId,
      vaultEventId: vault.event.id,
      scenarioId: `verify-${currencySlug}-shared-vault-one-time`,
      amount: oneTimeAmount,
      transactionSource: null,
      recurringModel: 'shared_vault',
      billingCycle: 'one_time_comparison',
      relatedEventId: first.event.id,
      orderId: `stage3-${runTag}-${currencySlug}-one-time`,
      label: `${candidate.currency} shared-vault one-time transaction`,
    });

    verifiedFlows.set(candidate.currency, {
      candidate,
      customerId,
      vault,
      first,
      next,
      oneTime,
    });
    rows.push(
      {
        operation: 'Vault verification',
        currency: candidate.currency,
        sentAccount: candidate.recurring.account.merchantAccountId,
        returnedAccount: vault.verification.actualMerchantAccountId,
        transactionSource: '—',
        braintreeId: vault.summary.verification?.id || vault.customerId,
        verified: 'yes',
      },
      {
        operation: 'Model A — first cycle',
        currency: first.result.transaction.currencyIsoCode,
        sentAccount: candidate.recurring.account.merchantAccountId,
        returnedAccount: first.result.transaction.merchantAccountId,
        transactionSource: 'recurring_first (sent)',
        braintreeId: first.result.transaction.id,
        verified: 'yes',
      }
    );
    if (next) {
      rows.push({
        operation: 'Model A — next cycle',
        currency: next.result.transaction.currencyIsoCode,
        sentAccount: candidate.recurring.account.merchantAccountId,
        returnedAccount: next.result.transaction.merchantAccountId,
        transactionSource: 'recurring (sent)',
        braintreeId: next.result.transaction.id,
        verified: 'yes',
      });
    }
    rows.push({
      operation: 'Shared vault — one-time',
      currency: oneTime.result.transaction.currencyIsoCode,
      sentAccount: candidate.oneTime.account.merchantAccountId,
      returnedAccount: oneTime.result.transaction.merchantAccountId,
      transactionSource: '—',
      braintreeId: oneTime.result.transaction.id,
      verified: 'yes',
    });
  }

  const selectedPlan = state.planDiscovery.status === 'ok'
    ? selectSubscriptionPlan(plans, accounts, subsequentCandidate.currency)
    : null;
  let subscriptionContext = null;
  let subscriptionCanceled = false;
  let cancellationAttempted = false;
  let primaryError = null;

  if (selectedPlan) {
    catalogService.assertPlanForRoute(
      selectedPlan.plan.id,
      selectedPlan.plan.currency
    );
    let subscriptionVault = verifiedFlows.get(selectedPlan.plan.currency)?.vault;
    if (!subscriptionVault) {
      subscriptionVault = await createVerifiedVault({
        gateway,
        decision: selectedPlan.decision,
        customerId: `demo-stage3-plan-${runTag}`,
        scenarioId:
          `verify-${selectedPlan.plan.currency.toLowerCase()}-subscription-vault`,
      });
    }

    const subscriptionScenarioId =
      `verify-${selectedPlan.plan.currency.toLowerCase()}-subscription`;

    try {
      const root = await createSubscription({
        gateway,
        decision: selectedPlan.decision,
        plan: selectedPlan.plan,
        vault: subscriptionVault,
        scenarioId: subscriptionScenarioId,
        onSubscriptionIdentified(subscriptionId) {
          subscriptionContext = {
            decision: selectedPlan.decision,
            plan: selectedPlan.plan,
            root: {
              id: subscriptionId,
              event: null,
              scenarioId: subscriptionScenarioId,
            },
            customerId: subscriptionVault.customerId,
          };
        },
      });
      subscriptionContext = {
        decision: selectedPlan.decision,
        plan: selectedPlan.plan,
        root,
        customerId: subscriptionVault.customerId,
      };
      const viewed = await viewSubscription({
        gateway,
        ...subscriptionContext,
      });
      cancellationAttempted = true;
      const canceled = await cancelSubscription({
        gateway,
        ...subscriptionContext,
      });
      subscriptionCanceled = true;
      rows.push({
        operation: 'Model B — create/view/cancel',
        currency: selectedPlan.plan.currency,
        sentAccount: selectedPlan.decision.account.merchantAccountId,
        returnedAccount: canceled.merchantAccountId,
        transactionSource: 'Braintree schedule',
        braintreeId: root.id,
        verified:
          String(viewed.status || 'unknown') + ' → ' +
          String(canceled.status || 'unknown'),
      });
    } catch (error) {
      primaryError = error;
    } finally {
      if (subscriptionContext && !subscriptionCanceled && !cancellationAttempted) {
        try {
          cancellationAttempted = true;
          await cancelSubscription({ gateway, ...subscriptionContext });
          subscriptionCanceled = true;
          console.warn(
            `Cleanup: canceled subscription ${subscriptionContext.root.id} after an earlier failure.`
          );
        } catch (cleanupError) {
          if (primaryError && !primaryError.cleanupError) {
            primaryError.cleanupError = cleanupError;
          } else if (!primaryError) {
            primaryError = cleanupError;
          }
        }
      }
    }
  }

  if (primaryError) throw primaryError;

  console.log('Stage 3 route verification:');
  console.table(rows);
  console.log(
    `Verified first recurring and same-vault one-time returned routing evidence for ` +
    `${sharedCandidates.length} eligible ${sharedCandidates.length === 1 ? 'currency' : 'currencies'}: ` +
    `${sharedCandidates.map((candidate) => candidate.currency).join(', ')}.`
  );
  console.log(
    `Verified a subsequent recurring cycle for ${subsequentCandidate.currency}` +
    `${subsequentCandidate.split ? ' on its split recurring route.' : '.'}`
  );
  console.log(
    'Sandbox verification passed. Transactions and demo customers remain as clearly labelled ' +
    'Sandbox artifacts; every created subscription was canceled.'
  );
}

if (require.main === module) {
  verifyStage3Sandbox().catch((error) => {
    const safeError = redact({
      name: error?.name ?? 'Error',
      message: safeRuntimeText(error?.message ?? 'Unknown error'),
      cleanupError: error?.cleanupError
        ? {
            name: error.cleanupError.name,
            message: safeRuntimeText(error.cleanupError.message),
          }
        : null,
    });
    console.error(
      `Stage 3 Sandbox verification failed (${safeError.name}): ${safeError.message}`
    );
    if (safeError.cleanupError?.message) {
      console.error(`Subscription cleanup also failed: ${safeError.cleanupError.message}`);
    }
    const pendingWarning = describePendingGatewayMutations();
    if (pendingWarning) console.error(pendingWarning);
    process.exitCode = 1;
  });
}

module.exports = {
  appendAuditedMutation,
  beginGatewayMutation,
  cancelSubscription,
  createSubscription,
  createVerifiedTransaction,
  describePendingGatewayMutations,
  sharedVaultCandidates,
  verifyStage3Sandbox,
};
