'use strict';

// These are Braintree Sandbox trigger amounts, expressed as whole major units.
// They are intentionally not converted with the storefront's fixed demo FX
// rates: Braintree applies these test outcomes regardless of processing currency.
const SANDBOX_EXPECTED_OUTCOMES = Object.freeze({
  approved: Object.freeze({
    key: 'approved',
    label: 'Approved payment',
    amount: null,
  }),
  processor_declined: Object.freeze({
    key: 'processor_declined',
    label: 'Processor decline',
    amount: '2001',
  }),
  gateway_rejected: Object.freeze({
    key: 'gateway_rejected',
    label: 'Gateway rejection',
    amount: '5001',
  }),
});

const SANDBOX_OUTCOME_AMOUNTS = Object.freeze(Object.fromEntries(
  Object.entries(SANDBOX_EXPECTED_OUTCOMES)
    .filter(([, outcome]) => outcome.amount !== null)
    .map(([key, outcome]) => [key, outcome.amount])
));

module.exports = {
  SANDBOX_EXPECTED_OUTCOMES,
  SANDBOX_OUTCOME_AMOUNTS,
};
