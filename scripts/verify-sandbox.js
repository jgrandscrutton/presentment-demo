'use strict';

const dotenv = require('dotenv');

dotenv.config({ path: ['./config.env', '.env'], quiet: true });

const { configureCatalogService } = require('../config/merchant-accounts');
const {
  getConfiguredMerchantId,
  getGateway,
  getGatewayClient,
} = require('../lib/braintree/gateway');
const { summarizeGatewayResult, verifyMerchantAccount } = require('../lib/braintree/result');
const { createCatalogService } = require('../lib/catalog/service');
const { getVerificationAmount } = require('../lib/currency');
const { append } = require('../lib/events/store');
const { redact } = require('../lib/inspector/redact');
const { resolveRoute } = require('../lib/routing/resolve-route');

async function verifySandbox() {
  const merchantId = getConfiguredMerchantId();
  const catalogService = createCatalogService({
    gateway: getGateway(),
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

  console.log('Discovered Braintree Sandbox merchant accounts:');
  console.table(
    state.accounts.map((account) => ({
      merchantAccountId: account.merchantAccountId,
      currency: account.currency,
      status: account.status,
      default: account.isDefault ? 'yes' : 'no',
      routes: account.paymentTypes.join(', ') || 'unassigned',
      source: account.roleSource || 'none',
    }))
  );
  if (state.warnings.length > 0) {
    for (const warning of state.warnings) {
      console.warn(`Catalog warning [${warning.code}]: ${warning.message}`);
    }
  }

  const gateway = getGatewayClient();
  const accounts = catalogService.getMerchantAccounts();
  const currencies = [...new Set(accounts.map((account) => account.currency))].sort();
  const runId = Date.now();
  const rows = [];

  for (const [index, currency] of currencies.entries()) {
    const decision = resolveRoute({ currency, paymentType: 'one_time' }, accounts);
    if (!decision.matched) {
      rows.push({
        currency,
        amount: '—',
        selected: 'no active one-time route',
        returned: '—',
        transactionId: '—',
        status: 'skipped',
        verified: 'n/a',
      });
      continue;
    }

    const amount = getVerificationAmount(currency, index);
    const scenarioId = `verify-${currency.toLowerCase()}-one-time`;
    append({
      type: 'route_resolution',
      stage: 1.5,
      source: 'verify:sandbox',
      scenarioId,
      intent: decision.intent,
      resolvedMerchantAccountId: decision.account.merchantAccountId,
      paymentMethodType: 'credit_card',
      amount,
      currency,
      outcome: 'matched',
      route: decision,
    });

    let result;
    try {
      result = await gateway.createSale({
        merchantAccountId: decision.account.merchantAccountId,
        amount,
        paymentMethodNonce: 'fake-valid-nonce',
        orderId: `routing-demo-verify-${currency}-${runId}`,
        submitForSettlement: true,
      });
    } catch (error) {
      try {
        append({
          type: 'transaction',
          stage: 1.5,
          source: 'verify:sandbox',
          scenarioId,
          intent: decision.intent,
          resolvedMerchantAccountId: decision.account.merchantAccountId,
          paymentMethodType: 'credit_card',
          amount,
          currency,
          outcome: 'gateway_error',
          error: { name: error?.name ?? 'Error', code: error?.code ?? null },
        });
      } catch {
        // Preserve the gateway error as the primary failure.
      }
      throw error;
    }

    const response = summarizeGatewayResult(result);
    const verification = verifyMerchantAccount(result, decision.account.merchantAccountId);
    try {
      append({
        type: 'transaction',
        stage: 1.5,
        source: 'verify:sandbox',
        scenarioId,
        intent: decision.intent,
        resolvedMerchantAccountId: decision.account.merchantAccountId,
        responseMerchantAccountId: result?.transaction?.merchantAccountId ?? null,
        verified: verification.passed,
        paymentMethodType: result?.transaction?.paymentInstrumentType ?? 'credit_card',
        amount: result?.transaction?.amount ?? amount,
        currency: result?.transaction?.currencyIsoCode ?? currency,
        outcome: result?.success === true && verification.passed ? 'succeeded' : 'failed',
        braintreeId: result?.transaction?.id ?? null,
        response,
        verification,
      });
    } catch (error) {
      throw new Error(
        `Braintree returned transaction ${result?.transaction?.id || 'without an ID'}, but its audit event could not be saved. Do not rerun the verifier until the event store is repaired.`,
        { cause: error }
      );
    }

    if (result?.success !== true) {
      throw new Error(
        `${currency} sandbox payment failed: ${response.message || 'Braintree returned an unsuccessful result'}`
      );
    }
    if (!verification.passed) {
      throw new Error(
        `${currency} route verification failed: expected ${verification.expectedMerchantAccountId}, received ${verification.actualMerchantAccountId || 'no account ID'}`
      );
    }

    rows.push({
      currency,
      amount: result.transaction.amount,
      selected: decision.account.merchantAccountId,
      returned: result.transaction.merchantAccountId,
      transactionId: result.transaction.id,
      status: result.transaction.status,
      verified: 'yes',
    });
  }

  console.log('One-time route verification:');
  console.table(rows);
  console.log('Sandbox verification passed: every discovered active one-time route matched the Braintree response.');
}

verifySandbox().catch((error) => {
  const safeError = redact(error);
  console.error(
    `Sandbox verification failed (${safeError.name || 'Error'}): ${safeError.message || 'Unknown error'}`
  );
  process.exitCode = 1;
});
