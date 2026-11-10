const braintreeService = require('../services/braintree-service');
const {
  buildBillingPlan,
  getInitialCharge,
  requireText,
  ValidationError,
} = require('../services/billing-service');
const catalogService = require('../services/catalog-service');
const transactionStore = require('../services/transaction-store');
const { billingAgreementService } = require('../services/billing-agreement-service');
const {
  createBillingQuote,
  createPurchaseQuote,
  resolveBillingQuote,
  resolvePurchaseQuote,
} = require('../services/billing-quote-service');

function transactionResponse(result, extra = {}) {
  if (!result.success) {
    return {
      status: 422,
      body: {
        success: false,
        error: result.message || 'Braintree rejected the transaction.',
      },
    };
  }

  const body = {
    success: true,
    transactionId: result.transaction.id,
    amount: result.transaction.amount,
    currency: result.transaction.currencyIsoCode || braintreeService.currency,
    ...extra,
  };
  transactionStore.add(body);

  return {
    status: 201,
    body,
  };
}

async function getClientToken(req, res, next) {
  try {
    const clientToken = await braintreeService.generateClientToken();
    res.json({
      clientToken,
      currency: braintreeService.currency,
    });
  } catch (error) {
    next(error);
  }
}

function sendBillingPlanPreview(input, audience, res) {
  const billingPlan = buildBillingPlan(input, braintreeService.currency);
  const quote = createBillingQuote(billingPlan, audience);
  res.json({
    success: true,
    planType: quote.plan.type,
    planDetails: quote.plan.planDetails,
    quoteToken: quote.token,
    quoteExpiresAt: quote.expiresAt,
  });
}

function previewBillingPlan(req, res, next) {
  try {
    sendBillingPlanPreview(catalogService.billingProduct(req.body.productId), 'catalog', res);
  } catch (error) {
    next(error);
  }
}

function previewCustomBillingPlan(req, res, next) {
  try {
    sendBillingPlanPreview(req.body, 'custom', res);
  } catch (error) {
    next(error);
  }
}

function previewTransaction(req, res, next) {
  try {
    const purchase = catalogService.oneTimePurchase(req.body);
    const quote = createPurchaseQuote({
      ...purchase,
      currency: braintreeService.currency,
    });
    res.json({
      success: true,
      ...purchase,
      currency: braintreeService.currency,
      quoteToken: quote.token,
      quoteExpiresAt: quote.expiresAt,
    });
  } catch (error) {
    next(error);
  }
}

async function createTransaction(req, res, next) {
  try {
    const nonce = requireText(req.body.nonce, 'nonce');
    const purchase = resolvePurchaseQuote(req.body.quoteToken);
    if (purchase.currency !== braintreeService.currency) {
      throw new ValidationError('The purchase currency has changed. Refresh the page and try again.');
    }

    const result = await braintreeService.createTransaction({
      nonce,
      amount: purchase.amount,
      orderId: purchase.description,
    });

    const response = transactionResponse(result, {
      description: purchase.description,
      paypalEmail: req.body.paypalEmail || 'N/A',
    });
    res.status(response.status).json(response.body);
  } catch (error) {
    next(error);
  }
}

async function createBillingTransaction(req, res, next) {
  try {
    const nonce = requireText(req.body.nonce, 'nonce');
    const billingPlan = resolveBillingQuote(req.body.quoteToken, 'catalog');
    await submitBillingTransaction(req, res, nonce, billingPlan);
  } catch (error) {
    next(error);
  }
}

async function createCustomBillingTransaction(req, res, next) {
  try {
    const nonce = requireText(req.body.nonce, 'nonce');
    const billingPlan = resolveBillingQuote(req.body.quoteToken, 'custom');
    await submitBillingTransaction(req, res, nonce, billingPlan);
  } catch (error) {
    next(error);
  }
}

async function submitBillingTransaction(req, res, nonce, billingPlan) {
  if (billingPlan.planDetails.currencyIsoCode !== braintreeService.currency) {
    throw new ValidationError('The billing currency has changed. Refresh the page and try again.');
  }

  const initialCharge = getInitialCharge(billingPlan);
  const payerEmail = typeof req.body.paypalEmail === 'string'
    ? req.body.paypalEmail.trim().slice(0, 255)
    : undefined;

  const vault = await braintreeService.vaultPaymentMethod({
    nonce,
    email: payerEmail,
  });

  if (!vault.success) {
    res.status(422).json({
      success: false,
      error: vault.message || 'Braintree could not vault the payment method.',
    });
    return;
  }

  let pendingAgreement;
  try {
    pendingAgreement = await billingAgreementService.createPending({
      billingPlan,
      vault,
      initialCharge,
    });
  } catch (error) {
    await braintreeService.deleteCustomer(vault.customerId).catch(() => {});
    throw error;
  }

  let result;
  try {
    result = await braintreeService.createTransaction({
      paymentMethodToken: vault.paymentMethodToken,
      amount: initialCharge.amount,
      orderId: pendingAgreement.inFlight.orderId,
      transactionSource: initialCharge.transactionSource,
    });
  } catch (error) {
    await billingAgreementService.failInitial(pendingAgreement.id, error.message, {
      ambiguous: true,
    });
    throw error;
  }

  if (!result.success) {
    let vaultRevoked = false;
    try {
      await braintreeService.deleteCustomer(vault.customerId);
      vaultRevoked = true;
    } catch {
      // Keep the Vault references on the failed agreement so an operator can retry cleanup.
    }
    await billingAgreementService.failInitial(
      pendingAgreement.id,
      result.message || 'Braintree rejected the initial transaction.',
      { vaultRevoked },
    );

    const response = transactionResponse(result);
    res.status(response.status).json(response.body);
    return;
  }

  let agreement;
  try {
    agreement = await billingAgreementService.activateInitial(
      pendingAgreement.id,
      result.transaction,
    );
  } catch (error) {
    await billingAgreementService.failInitial(
      pendingAgreement.id,
      `Braintree completed transaction ${result.transaction.id}, but local activation failed: ${error.message}`,
      { ambiguous: true },
    ).catch(() => {});
    throw error;
  }

  const response = transactionResponse(result, {
    description: billingPlan.description,
    paypalEmail: vault.email || payerEmail || 'N/A',
    message: initialCharge.message,
    agreementId: agreement.id,
    agreementStatus: agreement.status,
    nextChargeAt: agreement.nextChargeAt,
    billingType: billingPlan.type,
    recurringAmount: billingPlan.planDetails.recurringAmount || billingPlan.planDetails.amount,
    frequency: billingPlan.planDetails.frequency?.toLowerCase(),
    isVariable: billingPlan.type === 'recurring',
    reloadAmount: billingPlan.planDetails.reloadAmount,
    reloadThreshold: billingPlan.planDetails.reloadThreshold,
  });
  res.status(response.status).json(response.body);
}

module.exports = {
  getClientToken,
  previewBillingPlan,
  previewCustomBillingPlan,
  previewTransaction,
  createTransaction,
  createBillingTransaction,
  createCustomBillingTransaction,
};
