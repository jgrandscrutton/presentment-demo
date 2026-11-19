'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const appModule = require('../app');

function sentinelRouter(label) {
  const router = express.Router();
  router.get('/', (req, res) => res.type('text/plain').send(label));
  return router;
}

test('the Stage 4 disputes router is mounted ahead of the general demo router', () => {
  const demoDisputes = sentinelRouter('disputes');
  const demo = sentinelRouter('demo');
  const app = appModule.createApp({
    requestLogger: null,
    routers: { demoDisputes, demo },
  });

  const disputesLayerIndex = app.router.stack.findIndex(
    (layer) => layer.handle === demoDisputes
  );
  const demoLayerIndex = app.router.stack.findIndex(
    (layer) => layer.handle === demo
  );

  assert.notEqual(disputesLayerIndex, -1, 'the disputes router should be mounted');
  assert.notEqual(demoLayerIndex, -1, 'the general demo router should be mounted');
  assert.ok(
    disputesLayerIndex < demoLayerIndex,
    'the specific /demo/disputes mount must run before the /demo mount'
  );

  const disputesLayer = app.router.stack[disputesLayerIndex];
  const demoLayer = app.router.stack[demoLayerIndex];
  assert.equal(disputesLayer.matchers[0]('/demo/disputes')?.path, '/demo/disputes');
  assert.equal(demoLayer.matchers[0]('/demo/disputes')?.path, '/demo');
});
