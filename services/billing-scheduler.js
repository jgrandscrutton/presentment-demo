const environment = require('../config/environment');
const { billingAgreementService } = require('./billing-agreement-service');

let running = false;
let timer = null;

async function runBillingCycle(now = new Date()) {
  if (running) {
    return [];
  }

  running = true;
  try {
    return await billingAgreementService.runDue({
      now,
      limit: environment.billing.schedulerBatchSize,
    });
  } finally {
    running = false;
  }
}

async function startBillingScheduler() {
  const recovered = await billingAgreementService.markInterruptedChargesForReview();
  if (recovered) {
    console.warn('One or more interrupted billing charges require manual review.');
  }

  if (!environment.billing.schedulerEnabled) {
    console.log('Braintree recurring scheduler is disabled.');
    return;
  }

  if (!environment.billing.adminKey) {
    throw new Error(
      'BILLING_ADMIN_KEY is required when BILLING_SCHEDULER_ENABLED=true.',
    );
  }

  timer = setInterval(() => {
    runBillingCycle().catch(error => {
      console.error('Braintree recurring scheduler failed:', error);
    });
  }, environment.billing.schedulerIntervalMs);
  timer.unref();

  console.log(
    `Braintree recurring scheduler enabled (${environment.billing.schedulerIntervalMs}ms interval).`,
  );
}

function stopBillingScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  runBillingCycle,
  startBillingScheduler,
  stopBillingScheduler,
};
