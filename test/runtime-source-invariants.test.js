'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.hbs', '.json']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'data',
  'node_modules',
  'docs',
  'test',
]);

function runtimeSourceFiles(directory = ROOT) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(ROOT, absolutePath).split(path.sep).join('/');

    if (entry.isDirectory()) {
      if (relativePath === 'config/routing-policies') continue;
      files.push(...runtimeSourceFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push({
        path: relativePath,
        source: fs.readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  return files;
}

test('runtime source contains no Stage 1 merchant-account allowlist', () => {
  const violations = [];

  for (const file of runtimeSourceFiles()) {
    for (const merchantAccountId of ['paypal2', 'vmUSD', 'vmUSD2']) {
      if (new RegExp(`\\b${merchantAccountId}\\b`, 'i').test(file.source)) {
        violations.push(`${file.path}: ${merchantAccountId}`);
      }
    }

    file.source.split(/\r?\n/).forEach((line, index) => {
      if (!/(['"])paypal\1/i.test(line)) return;

      const isPaymentMethod = /paymentMethod/i.test(line);
      const isWebhookPath = /router\.post\(\s*['"]\/paypal['"]/i.test(line);
      if (!isPaymentMethod && !isWebhookPath) {
        violations.push(`${file.path}:${index + 1}: ambiguous quoted paypal ID`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Gateway-specific merchant account IDs leaked into runtime source:\n${violations.join('\n')}`
  );
});

test('gateway-specific Stage 1 currencies live only in dedicated configuration', () => {
  const allowedRuntimeFiles = new Set([
    'config/demo-currency.js',
    'lib/demo/scenarios.js',
  ]);
  const violations = [];

  for (const file of runtimeSourceFiles()) {
    if (allowedRuntimeFiles.has(file.path)) continue;

    file.source.split(/\r?\n/).forEach((line, index) => {
      const matches = [...line.matchAll(/(['"])(GBP|EUR|USD)\1/g)];
      for (const match of matches) {
        violations.push(`${file.path}:${index + 1}: ${match[2]}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Gateway-specific currency constants leaked into runtime source:\n${violations.join('\n')}`
  );
});
