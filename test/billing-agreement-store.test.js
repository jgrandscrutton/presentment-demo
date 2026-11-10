const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BillingAgreementStore } = require('../services/billing-agreement-store');

test('keeps in-memory and on-disk agreement state unchanged when an atomic write fails', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'agreements.json');
  const store = new BillingAgreementStore(filePath);
  const agreement = {
    id: 'ba_atomic-test',
    status: 'active',
    nextChargeAt: '2026-02-01T00:00:00.000Z',
    inFlight: null,
  };

  await store.create(agreement);
  store.write = async () => {
    throw new Error('simulated disk failure');
  };

  await assert.rejects(
    store.update(agreement.id, current => ({ ...current, status: 'paused' })),
    /simulated disk failure/,
  );
  assert.equal((await store.require(agreement.id)).status, 'active');

  const reloaded = new BillingAgreementStore(filePath);
  assert.equal((await reloaded.require(agreement.id)).status, 'active');
});
