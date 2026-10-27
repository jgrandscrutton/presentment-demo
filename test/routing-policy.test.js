'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { loadRoutingPolicy } = require('../lib/catalog/policy');

async function withPolicyDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-policy-test-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('missing gateway policy warns and selects automatic assignment', async () => {
  await withPolicyDirectory(async (policiesDirectory) => {
    const result = await loadRoutingPolicy({
      merchantId: 'missing-policy-merchant',
      policiesDirectory,
    });

    assert.equal(result.policy, null);
    assert.equal(result.source, 'missing');
    assert.equal(result.warnings[0].code, 'POLICY_NOT_FOUND');
  });
});

test('matching policy loads and a merchant mismatch is ignored with a warning', async () => {
  await withPolicyDirectory(async (policiesDirectory) => {
    await fs.writeFile(
      path.join(policiesDirectory, 'matching-merchant.json'),
      JSON.stringify({
        merchantId: 'matching-merchant',
        accounts: {
          configured: { label: 'Configured', paymentTypes: ['one_time'] },
        },
      })
    );
    await fs.writeFile(
      path.join(policiesDirectory, 'mismatch-merchant.json'),
      JSON.stringify({ merchantId: 'another-merchant', accounts: {} })
    );

    const matching = await loadRoutingPolicy({
      merchantId: 'matching-merchant',
      policiesDirectory,
    });
    const mismatch = await loadRoutingPolicy({
      merchantId: 'mismatch-merchant',
      policiesDirectory,
    });

    assert.equal(matching.source, 'loaded');
    assert.equal(matching.policy.accounts.configured.label, 'Configured');
    assert.equal(mismatch.policy, null);
    assert.equal(mismatch.source, 'mismatch');
    assert.equal(mismatch.warnings[0].code, 'POLICY_MERCHANT_ID_MISMATCH');
  });
});

test('unsafe merchant IDs are rejected instead of becoming file paths', async () => {
  await assert.rejects(
    loadRoutingPolicy({ merchantId: '../outside' }),
    /merchant ID is invalid/
  );
});
