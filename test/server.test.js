'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getServerHost, isLoopbackHost } = require('../server');

test('server binds to loopback unless network exposure is explicitly configured', () => {
  assert.equal(getServerHost({}), '127.0.0.1');
  assert.equal(getServerHost({ HOST: '' }), '127.0.0.1');
  assert.equal(getServerHost({ HOST: ' 127.0.0.1 ' }), '127.0.0.1');
  assert.equal(getServerHost({ HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(getServerHost({ HOST: '::1' }), '::1');
  assert.equal(getServerHost({ HOST: 'demo.internal' }), 'demo.internal');
  assert.equal(getServerHost({ HOST: 'demo.internal.' }), 'demo.internal.');
});

test('server host validation rejects values that are not hostnames or IP literals', () => {
  for (const host of [
    '127.0.0.1/path',
    '127.0.0.1:3000',
    'http:',
    'two hosts',
    'bad\\host',
    '-',
    'name..example',
    `bad\0host`,
    `${'a'.repeat(64)}.example`,
  ]) {
    assert.throws(() => getServerHost({ HOST: host }), /HOST/, host);
  }
});

test('loopback detection distinguishes local and explicitly exposed hosts', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.0.2.10'), false);
});
