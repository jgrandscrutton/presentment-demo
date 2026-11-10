const crypto = require('node:crypto');
const braintreeService = require('./braintree-service');
const { billingAgreementStore } = require('./billing-agreement-store');
const { ValidationError, normalizeAmount } = require('./billing-service');
const {
  billingDateForOccurrence,
  firstBillingOccurrenceAfter,
  nextBillingDate,
} = require('./schedule-service');

class AgreementStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgreementStateError';
    this.statusCode = 409;
  }
}

function scheduledType(type) {
  return ['subscription', 'recurring', 'installments', 'hybrid'].includes(type);
}

function termsFromPlan(billingPlan) {
  const { type, planDetails } = billingPlan;

  return {
    amount: type === 'hybrid'
      ? planDetails.recurringAmount
      : (planDetails.amount || planDetails.reloadAmount),
    frequency: planDetails.frequency || null,
    totalCycles: type === 'installments' ? planDetails.totalCycles : null,
    reloadThreshold: planDetails.reloadThreshold || null,
  };
}

function initialCompletedCycles(type) {
  return type === 'hybrid' ? 0 : 1;
}

function subsequentTransactionSource(agreement) {
  if (agreement.type === 'installments') {
    return agreement.completedCycles === 0 ? 'installment_first' : 'installment';
  }
  if (agreement.type === 'unscheduled') {
    return 'unscheduled';
  }
  if (agreement.type === 'hybrid') {
    return 'recurring';
  }
  if (agreement.completedCycles === 0) {
    return 'recurring_first';
  }
  return 'recurring';
}

function publicAgreement(agreement) {
  const {
    paymentMethodToken,
    inFlight,
    ...safeAgreement
  } = agreement;

  return {
    ...safeAgreement,
    hasPaymentMethod: Boolean(paymentMethodToken),
    chargeInProgress: Boolean(inFlight),
    inFlightOrderId: inFlight?.orderId,
  };
}

const CONFIRMED_TRANSACTION_STATUSES = new Set([
  'authorized',
  'submitted_for_settlement',
  'settlement_pending',
  'settling',
  'settled',
  'settlement_confirmed',
]);

function createBillingAgreementService({
  store = billingAgreementStore,
  gateway = braintreeService,
} = {}) {
  async function createPending({ billingPlan, vault, initialCharge, now = new Date() }) {
    const timestamp = new Date(now).toISOString();
    const id = `ba_${crypto.randomUUID()}`;
    const terms = termsFromPlan(billingPlan);
    const billingAnchorAt = scheduledType(billingPlan.type)
      ? new Date(
        billingPlan.planDetails.firstBillingDate
          || nextBillingDate(now, terms.frequency),
      ).toISOString()
      : null;
    const agreement = {
      id,
      status: 'pending_initial',
      type: billingPlan.type,
      description: billingPlan.description,
      customerId: vault.customerId,
      paymentMethodToken: vault.paymentMethodToken,
      payerEmail: vault.email || null,
      currency: billingPlan.planDetails.currencyIsoCode,
      amount: terms.amount,
      frequency: terms.frequency,
      totalCycles: terms.totalCycles,
      completedCycles: 0,
      billingAnchorAt,
      nextOccurrence: billingAnchorAt ? 0 : null,
      reloadThreshold: terms.reloadThreshold,
      balance: billingPlan.type === 'unscheduled' ? '0.00' : null,
      nextChargeAt: null,
      lastChargedAt: null,
      lastTransactionId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      transactions: [],
      inFlight: {
        kind: 'initial',
        orderId: `${id}-initial`,
        amount: initialCharge.amount,
        startedAt: timestamp,
      },
    };

    return store.create(agreement);
  }

  async function activateInitial(id, transaction, now = new Date()) {
    const processedAt = new Date(now);

    return store.update(id, agreement => {
      if (
        !['pending_initial', 'review_required'].includes(agreement.status) ||
        agreement.inFlight?.kind !== 'initial'
      ) {
        throw new AgreementStateError('The agreement is not awaiting its initial transaction.');
      }

      const completedCycles = initialCompletedCycles(agreement.type);
      const isComplete = agreement.type === 'installments' && completedCycles >= agreement.totalCycles;
      const nextStatus = isComplete
        ? 'completed'
        : (agreement.type === 'recurring' ? 'awaiting_amount' : 'active');
      const hasSchedule = scheduledType(agreement.type) && !isComplete;

      return {
        ...agreement,
        status: nextStatus,
        completedCycles,
        nextOccurrence: hasSchedule ? (agreement.nextOccurrence ?? 0) : null,
        balance: agreement.type === 'unscheduled' ? agreement.amount : agreement.balance,
        nextChargeAt: hasSchedule
          ? agreement.billingAnchorAt
          : null,
        lastChargedAt: processedAt.toISOString(),
        lastTransactionId: transaction.id,
        lastError: null,
        transactions: [
          ...agreement.transactions,
          {
            id: transaction.id,
            amount: transaction.amount,
            kind: 'initial',
            chargedAt: processedAt.toISOString(),
          },
        ],
        inFlight: null,
      };
    });
  }

  async function failInitial(id, message, { ambiguous = false, vaultRevoked = false } = {}) {
    return store.update(id, agreement => ({
      ...agreement,
      status: ambiguous ? 'review_required' : 'failed',
      lastError: message,
      inFlight: ambiguous ? agreement.inFlight : null,
      customerId: !ambiguous && vaultRevoked ? null : agreement.customerId,
      paymentMethodToken: !ambiguous && vaultRevoked ? null : agreement.paymentMethodToken,
      vaultRevokedAt: !ambiguous && vaultRevoked ? new Date().toISOString() : agreement.vaultRevokedAt,
    }));
  }

  async function beginCharge(id, { now = new Date(), force = false, amount } = {}) {
    const startedAt = new Date(now);

    return store.update(id, agreement => {
      if (agreement.inFlight) {
        throw new AgreementStateError('A charge is already in progress for this agreement.');
      }
      if (!['active', 'past_due'].includes(agreement.status)) {
        throw new AgreementStateError(`Cannot charge an agreement with status ${agreement.status}.`);
      }
      if (!force && (!agreement.nextChargeAt || new Date(agreement.nextChargeAt) > startedAt)) {
        throw new AgreementStateError('This agreement is not due for a charge.');
      }
      if (agreement.type === 'installments' && agreement.completedCycles >= agreement.totalCycles) {
        throw new AgreementStateError('All installments have already been completed.');
      }
      if (amount !== undefined && !['recurring', 'unscheduled'].includes(agreement.type)) {
        throw new AgreementStateError('This agreement has a fixed charge amount.');
      }

      const chargeAmount = amount !== undefined ? normalizeAmount(amount) : agreement.amount;
      const sequence = agreement.completedCycles + 1;
      const occurrence = scheduledType(agreement.type)
        ? (agreement.nextOccurrence ?? 0)
        : null;

      return {
        ...agreement,
        status: 'active',
        inFlight: {
          kind: agreement.type === 'unscheduled' ? 'unscheduled' : 'scheduled',
          orderId: `${agreement.id}-${sequence}-${crypto.randomUUID().slice(0, 8)}`,
          amount: chargeAmount,
          occurrence,
          scheduledFor: occurrence !== null && agreement.billingAnchorAt
            ? billingDateForOccurrence(
              agreement.billingAnchorAt,
              agreement.frequency,
              occurrence,
            ).toISOString()
            : agreement.nextChargeAt,
          startedAt: startedAt.toISOString(),
        },
      };
    });
  }

  async function completeCharge(id, transaction, now = new Date()) {
    const processedAt = new Date(now);

    return store.update(id, agreement => {
      if (!agreement.inFlight || agreement.inFlight.kind === 'initial') {
        throw new AgreementStateError('No scheduled charge is in progress for this agreement.');
      }

      const completedCycles = agreement.completedCycles + 1;
      const isComplete = agreement.type === 'installments' && completedCycles >= agreement.totalCycles;
      const nextStatus = isComplete
        ? 'completed'
        : (agreement.type === 'recurring' ? 'awaiting_amount' : 'active');
      const hasSchedule = scheduledType(agreement.type) && !isComplete;
      const chargedOccurrence = agreement.inFlight.occurrence
        ?? agreement.nextOccurrence
        ?? 0;
      const upcoming = hasSchedule
        ? firstBillingOccurrenceAfter(
          agreement.billingAnchorAt,
          agreement.frequency,
          processedAt,
          chargedOccurrence + 1,
        )
        : null;
      const nextBalance = agreement.type === 'unscheduled'
        ? (Number(agreement.balance) + Number(transaction.amount)).toFixed(2)
        : agreement.balance;

      return {
        ...agreement,
        status: nextStatus,
        completedCycles,
        nextOccurrence: upcoming?.occurrence ?? null,
        balance: nextBalance,
        nextChargeAt: upcoming?.date.toISOString() || null,
        lastChargedAt: processedAt.toISOString(),
        lastTransactionId: transaction.id,
        lastError: null,
        transactions: [
          ...agreement.transactions,
          {
            id: transaction.id,
            amount: transaction.amount,
            kind: agreement.inFlight.kind,
            chargedAt: processedAt.toISOString(),
          },
        ].slice(-100),
        inFlight: null,
      };
    });
  }

  async function failCharge(id, message, { ambiguous = false } = {}) {
    return store.update(id, agreement => ({
      ...agreement,
      status: ambiguous ? 'review_required' : 'past_due',
      nextChargeAt: null,
      lastError: message,
      inFlight: ambiguous ? agreement.inFlight : null,
    }));
  }

  async function charge(id, options = {}) {
    const agreement = await beginCharge(id, options);

    let result;
    try {
      result = await gateway.createTransaction({
        paymentMethodToken: agreement.paymentMethodToken,
        amount: agreement.inFlight.amount,
        orderId: agreement.inFlight.orderId,
        transactionSource: subsequentTransactionSource(agreement),
      });
    } catch (error) {
      await failCharge(id, error.message, { ambiguous: true });
      throw error;
    }

    if (!result.success) {
      await failCharge(id, result.message || 'Braintree rejected the recurring transaction.');
      return {
        success: false,
        error: result.message || 'Braintree rejected the recurring transaction.',
        agreement: publicAgreement(await store.require(id)),
      };
    }

    let updated;
    try {
      updated = await completeCharge(id, result.transaction, options.now);
    } catch (error) {
      await failCharge(
        id,
        `Braintree completed transaction ${result.transaction.id}, but local completion failed: ${error.message}`,
        { ambiguous: true },
      ).catch(() => {});
      throw error;
    }
    return {
      success: true,
      transactionId: result.transaction.id,
      agreement: publicAgreement(updated),
    };
  }

  async function runDue({ now = new Date(), limit = 20 } = {}) {
    const due = await store.listDue(now, limit);
    const results = [];

    for (const agreement of due) {
      try {
        results.push({ id: agreement.id, ...(await charge(agreement.id, { now })) });
      } catch (error) {
        results.push({ id: agreement.id, success: false, error: error.message });
      }
    }

    return results;
  }

  async function pause(id) {
    return store.update(id, agreement => {
      if (agreement.inFlight) {
        throw new AgreementStateError('Cannot pause an agreement while a charge is in progress.');
      }
      if (!['active', 'awaiting_amount', 'past_due'].includes(agreement.status)) {
        throw new AgreementStateError(`Cannot pause an agreement with status ${agreement.status}.`);
      }
      return { ...agreement, status: 'paused', nextChargeAt: null };
    });
  }

  async function resume(id, now = new Date()) {
    const resumedAt = new Date(now);
    return store.update(id, agreement => {
      if (agreement.inFlight) {
        throw new AgreementStateError('Resolve the in-progress charge before resuming this agreement.');
      }
      if (!['paused', 'past_due'].includes(agreement.status)) {
        throw new AgreementStateError(`Cannot resume an agreement with status ${agreement.status}.`);
      }
      const hasSchedule = scheduledType(agreement.type);
      const upcoming = hasSchedule
        ? firstBillingOccurrenceAfter(
          agreement.billingAnchorAt,
          agreement.frequency,
          resumedAt,
          agreement.nextOccurrence ?? 0,
        )
        : null;

      return {
        ...agreement,
        status: agreement.type === 'recurring' ? 'awaiting_amount' : 'active',
        nextOccurrence: upcoming?.occurrence ?? agreement.nextOccurrence,
        nextChargeAt: upcoming?.date.toISOString() || null,
        lastError: null,
      };
    });
  }

  async function cancel(id) {
    let previousStatus;
    let previousNextChargeAt;
    const agreement = await store.update(id, current => {
      if (current.inFlight) {
        throw new AgreementStateError('Cannot cancel an agreement while a charge is in progress.');
      }
      if (['cancelled', 'completed', 'cancelling'].includes(current.status)) {
        throw new AgreementStateError(`Agreement is already ${current.status}.`);
      }
      previousStatus = current.status;
      previousNextChargeAt = current.nextChargeAt;
      return { ...current, status: 'cancelling', nextChargeAt: null };
    });

    try {
      await gateway.deleteCustomer(agreement.customerId);
    } catch (error) {
      await store.update(id, current => ({
        ...current,
        status: previousStatus,
        nextChargeAt: previousNextChargeAt,
        lastError: `Could not revoke the Braintree Vault customer: ${error.message}`,
      }));
      throw error;
    }

    return store.update(id, current => ({
      ...current,
      status: 'cancelled',
      nextChargeAt: null,
      customerId: null,
      paymentMethodToken: null,
      vaultRevokedAt: new Date().toISOString(),
    }));
  }

  async function updateVariableAmount(id, amount) {
    const normalizedAmount = normalizeAmount(amount);
    return store.update(id, agreement => {
      if (!['recurring', 'unscheduled'].includes(agreement.type)) {
        throw new AgreementStateError('Only variable or unscheduled agreements can change amount.');
      }
      if (!['active', 'awaiting_amount', 'paused', 'past_due'].includes(agreement.status)) {
        throw new AgreementStateError(`Cannot update an agreement with status ${agreement.status}.`);
      }
      return {
        ...agreement,
        amount: normalizedAmount,
        status: agreement.status === 'awaiting_amount' ? 'active' : agreement.status,
      };
    });
  }

  async function recordUsage(id, amount, now = new Date()) {
    const usage = normalizeAmount(amount, 'usage amount');
    const agreement = await store.update(id, current => {
      if (current.type !== 'unscheduled') {
        throw new AgreementStateError('Usage can only be recorded for unscheduled agreements.');
      }
      if (current.status !== 'active') {
        throw new AgreementStateError(`Cannot record usage while agreement is ${current.status}.`);
      }

      return {
        ...current,
        balance: Math.max(0, Number(current.balance) - Number(usage)).toFixed(2),
      };
    });

    if (Number(agreement.balance) >= Number(agreement.reloadThreshold)) {
      return { reloaded: false, agreement: publicAgreement(agreement) };
    }

    const result = await charge(id, { now, force: true });
    return { reloaded: result.success, ...result };
  }

  async function resolveReview(id, { outcome, transactionId, now = new Date() }) {
    const agreement = await store.require(id);
    if (agreement.status !== 'review_required' || !agreement.inFlight) {
      throw new AgreementStateError('This agreement does not have an interrupted charge to resolve.');
    }

    if (outcome === 'charged') {
      const idFromBraintree = typeof transactionId === 'string' ? transactionId.trim() : '';
      if (!idFromBraintree) {
        throw new ValidationError('transactionId is required when the charge succeeded.');
      }

      let transaction;
      try {
        transaction = await gateway.findTransaction(idFromBraintree);
      } catch {
        throw new AgreementStateError(
          'Braintree could not verify that transaction. The agreement remains under review.',
        );
      }

      const actualAmount = normalizeAmount(String(transaction.amount));
      const status = String(transaction.status || '').toLowerCase();
      const mismatches = [
        transaction.id !== idFromBraintree && 'transaction ID',
        transaction.orderId !== agreement.inFlight.orderId && 'order ID',
        actualAmount !== agreement.inFlight.amount && 'amount',
        transaction.currencyIsoCode !== agreement.currency && 'currency',
        transaction.type && transaction.type !== 'sale' && 'transaction type',
        !CONFIRMED_TRANSACTION_STATUSES.has(status) && 'transaction status',
        transaction.customer?.id && transaction.customer.id !== agreement.customerId && 'customer',
      ].filter(Boolean);

      if (mismatches.length > 0) {
        throw new AgreementStateError(
          `The Braintree transaction does not match the interrupted charge (${mismatches.join(', ')}).`,
        );
      }

      const updated = agreement.inFlight.kind === 'initial'
        ? await activateInitial(id, { id: transaction.id, amount: actualAmount }, now)
        : await completeCharge(id, { id: transaction.id, amount: actualAmount }, now);
      return publicAgreement(updated);
    }

    if (outcome === 'not_charged') {
      const updated = await store.update(id, current => ({
        ...current,
        status: current.inFlight.kind === 'initial' ? 'failed' : 'past_due',
        nextChargeAt: null,
        lastError: 'Interrupted charge was confirmed not to have completed.',
        inFlight: null,
      }));
      return publicAgreement(updated);
    }

    throw new ValidationError('outcome must be either "charged" or "not_charged".');
  }

  async function get(id) {
    return publicAgreement(await store.require(id));
  }

  async function list() {
    return (await store.list()).map(publicAgreement);
  }

  return {
    createPending,
    activateInitial,
    failInitial,
    charge,
    runDue,
    pause,
    resume,
    cancel,
    updateVariableAmount,
    recordUsage,
    resolveReview,
    get,
    list,
    markInterruptedChargesForReview: () => store.markInterruptedChargesForReview(),
    publicAgreement,
  };
}

const billingAgreementService = createBillingAgreementService();

module.exports = {
  AgreementStateError,
  createBillingAgreementService,
  billingAgreementService,
};
