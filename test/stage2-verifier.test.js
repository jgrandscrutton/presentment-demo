'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertRoutedResult,
  describePendingGatewayMutation,
  getPendingGatewayMutation,
  markGatewayMutationAudited,
  requestGatewayMutation,
} = require('../scripts/verify-stage2-sandbox');

const decision = Object.freeze({
  account: Object.freeze({ merchantAccountId: 'account-gbp' }),
});

function transaction(overrides = {}) {
  return {
    id: 'txn-stage2',
    merchantAccountId: 'account-gbp',
    currencyIsoCode: 'GBP',
    ...overrides,
  };
}

test('expected verifier failures require an explicit false success result', () => {
  for (const malformed of [
    { transaction: transaction() },
    { success: null, transaction: transaction() },
    { success: 'false', transaction: transaction() },
  ]) {
    assert.throws(
      () => assertRoutedResult(
        malformed,
        decision,
        'GBP',
        'Expected processor decline',
        { success: false }
      ),
      /returned success=/
    );
  }

  const verification = assertRoutedResult(
    { success: false, transaction: transaction() },
    decision,
    'GBP',
    'Expected processor decline',
    { success: false }
  );
  assert.equal(verification.passed, true);
});

test('pending mutation tracking retains identifiers until the audit checkpoint', async () => {
  markGatewayMutationAudited();
  const result = await requestGatewayMutation({
    label: 'partial capture',
    reference: 'order-stage2',
  }, async () => ({
    success: true,
    transaction: transaction({ id: 'txn-captured' }),
  }));

  assert.equal(result.success, true);
  assert.deepEqual(getPendingGatewayMutation(), {
    label: 'partial capture',
    reference: 'order-stage2',
    transactionId: 'txn-captured',
  });
  assert.match(describePendingGatewayMutation(), /Transaction: txn-captured/);
  assert.match(describePendingGatewayMutation(), /Do not rerun/);

  markGatewayMutationAudited();
  assert.equal(getPendingGatewayMutation(), null);
  assert.equal(describePendingGatewayMutation(), null);
});

test('a thrown gateway request remains marked as potentially ambiguous', async () => {
  markGatewayMutationAudited();
  await assert.rejects(
    requestGatewayMutation({
      label: 'Sandbox settlement',
      transactionId: 'txn-settlement',
    }, async () => {
      throw new Error('connection closed');
    }),
    /connection closed/
  );

  assert.deepEqual(getPendingGatewayMutation(), {
    label: 'Sandbox settlement',
    reference: null,
    transactionId: 'txn-settlement',
  });
  assert.match(describePendingGatewayMutation(), /Sandbox Control Panel/);
  markGatewayMutationAudited();
});

test('an ambiguous sale warning retains its request reference before an ID exists', async () => {
  markGatewayMutationAudited();
  await assert.rejects(
    requestGatewayMutation({
      label: 'authorization',
      reference: 'routing-demo-stage2-authorize-123',
    }, async () => {
      throw new Error('connection closed');
    }),
    /connection closed/
  );

  const warning = describePendingGatewayMutation();
  assert.match(warning, /Request reference: routing-demo-stage2-authorize-123/);
  assert.doesNotMatch(warning, /Transaction:/);
  markGatewayMutationAudited();
});
