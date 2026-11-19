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

      const isPaymentMethod = /(?:paymentMethod|canonicalMethod)/i.test(line);
      if (!isPaymentMethod) {
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

test('runtime payment source contains no direct PPCP, PayPal REST, or OAuth integration', () => {
  const prohibitedPatterns = [
    ['PayPal REST API host', /https?:\/\/api(?:-m)?(?:\.sandbox)?\.paypal\.com/i],
    ['PayPal OAuth token endpoint', /\/v1\/oauth2\/token/i],
    ['PayPal Orders API endpoint', /\/v2\/checkout\/orders/i],
    ['PayPal REST credentials', /\bPAYPAL_(?:CLIENT_ID|CLIENT_SECRET)\b/],
    ['direct PayPal SDK client ID', /\bclient-id\s*=/i],
    [
      'PayPal server SDK dependency',
      /(?:@paypal\/(?:paypal-server-sdk|checkout-server-sdk)|paypal-rest-sdk)/i,
    ],
    [
      'direct PayPal JavaScript SDK script',
      /https?:\/\/(?:www\.|www\.sandbox\.)?paypal\.com\/sdk\/js/i,
    ],
  ];
  const violations = [];

  for (const file of runtimeSourceFiles()) {
    for (const [label, pattern] of prohibitedPatterns) {
      if (pattern.test(file.source)) violations.push(`${file.path}: ${label}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Direct PPCP integration leaked into Braintree-only runtime source:\n${violations.join('\n')}`
  );
});

test('every PayPal button is mediated by Braintree PayPal Checkout', () => {
  const violations = [];

  for (const file of runtimeSourceFiles()) {
    const buttonCalls = [
      ...file.source.matchAll(/paypal\.Buttons\s*\(([\s\S]*?)\)\.render\s*\(/g),
    ];
    if (buttonCalls.length === 0) continue;

    const checkoutNames = ['paypalCheckoutInstance', ...Array.from(file.source.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:window\.)?braintree\.paypalCheckout\.create\s*\(/g
    ), (match) => match[1])];
    const checkoutReference = `(?:${checkoutNames.join('|')})`;

    const requiredFileMarkers = [
      ['Braintree client', /braintree\.client\.create\s*\(/],
      ['Braintree PayPal Checkout component', /braintree\.paypalCheckout\.create\s*\(/],
      ['Braintree-managed PayPal SDK load', new RegExp(`${checkoutReference}\\.loadPayPalSDK\\s*\\(`)],
    ];

    for (const [label, pattern] of requiredFileMarkers) {
      if (!pattern.test(file.source)) violations.push(`${file.path}: missing ${label}`);
    }

    buttonCalls.forEach((call, index) => {
      const buttonSource = call[1];
      const requiredButtonMarkers = [
        ['Braintree payment creation', new RegExp(`${checkoutReference}\\.createPayment\\s*\\(`)],
        ['Braintree nonce tokenization', new RegExp(`${checkoutReference}\\.tokenizePayment\\s*\\(`)],
      ];

      for (const [label, pattern] of requiredButtonMarkers) {
        if (!pattern.test(buttonSource)) {
          violations.push(`${file.path}: PayPal button ${index + 1} missing ${label}`);
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `A PayPal button bypasses the Braintree mediation chain:\n${violations.join('\n')}`
  );
});

test('card authentication uses Braintree 3D Secure v2 before submitting an upgraded nonce', () => {
  const viewSource = fs.readFileSync(path.join(ROOT, 'views/demo.hbs'), 'utf8');
  const clientSource = fs.readFileSync(
    path.join(ROOT, 'public/scripts/demo.js'),
    'utf8'
  );

  assert.match(
    viewSource,
    /braintreegateway\.com\/web\/[^"']+\/js\/three-d-secure\.min\.js/,
    'The demo must load the Braintree 3D Secure component.'
  );
  assert.match(
    clientSource,
    /braintree\.threeDSecure\.create\s*\(\s*{\s*client,\s*version:\s*2\s*}\s*\)/,
    '3D Secure v2 must use the client created from the resolved account token.'
  );
  assert.match(
    clientSource,
    /braintree\.hostedFields\.create\s*\(\s*{\s*client,/,
    'Hosted Fields must share that resolved-account Braintree client.'
  );
  assert.match(
    clientSource,
    /threeDSecureInstance\.verifyCard\s*\(\s*{[\s\S]*?amount:\s*submittedIntent\.amount,[\s\S]*?nonce:\s*paymentMethod\.nonce,[\s\S]*?bin:\s*paymentMethod\.details\.bin,[\s\S]*?onLookupComplete\s*\([^)]*\)\s*{[\s\S]*?next\(\)/,
    'Card verification must bind the amount, tokenized nonce, BIN, and lookup continuation.'
  );

  const verifyCall = clientSource.indexOf('threeDSecureInstance.verifyCard');
  const upgradedNonce = clientSource.indexOf('verification.nonce', verifyCall);
  const submitCall = clientSource.indexOf('submitTokenizedPayment(', upgradedNonce);
  assert.ok(verifyCall >= 0, 'A 3D Secure verification call is required.');
  assert.ok(
    upgradedNonce > verifyCall,
    'The client must read the upgraded nonce returned by 3D Secure.'
  );
  assert.ok(
    submitCall > upgradedNonce,
    'Only the upgraded 3D Secure nonce may be submitted after verification.'
  );
});

test('server enforces account-owned 3D Secure policy before card mutations', () => {
  const oneTimeSource = fs.readFileSync(
    path.join(ROOT, 'routes/demo-api.js'),
    'utf8'
  );
  const recurringSource = fs.readFileSync(
    path.join(ROOT, 'routes/demo-recurring-api.js'),
    'utf8'
  );
  const gatewaySource = fs.readFileSync(
    path.join(ROOT, 'lib/braintree/gateway.js'),
    'utf8'
  );

  const oneTimeGate = oneTimeSource.indexOf(
    'const nonceThreeDSecureVerification = verifyThreeDSecure'
  );
  const oneTimeSale = oneTimeSource.indexOf('gateway().createSale', oneTimeGate);
  assert.ok(oneTimeGate >= 0, 'One-time Card requests need a server 3DS gate.');
  assert.ok(
    oneTimeSale > oneTimeGate,
    'One-time 3DS evidence must be checked before the sale mutation.'
  );
  assert.match(
    oneTimeSource.slice(oneTimeGate, oneTimeSale),
    /policy:\s*decision\.account\.threeDSecurePolicy/,
    'The one-time gate must use the server-resolved account policy.'
  );
  assert.match(
    oneTimeSource.slice(oneTimeGate, oneTimeSale),
    /if\s*\(\s*!nonceThreeDSecureVerification\.passed\s*\)/,
    'Failed one-time 3DS evidence must stop before sale.'
  );
  assert.match(
    oneTimeSource,
    /threeDSecureRequired:\s*nonceThreeDSecureVerification\.required/,
    'The transaction request must carry the server-owned required flag.'
  );

  const recurringGate = recurringSource.search(
    /\b(?:const|let)\s+threeDSecureVerification\s*=\s*verifyThreeDSecure/
  );
  const vaultMutation = recurringSource.indexOf(
    'gateway().createVaultedCustomer',
    recurringGate
  );
  assert.ok(recurringGate >= 0, 'Recurring Card requests need a server 3DS gate.');
  assert.ok(
    vaultMutation > recurringGate,
    'Recurring 3DS evidence must be checked before the vault mutation.'
  );
  assert.match(
    recurringSource.slice(recurringGate, vaultMutation),
    /policy:\s*resolved\.decision\.account\.threeDSecurePolicy/,
    'The recurring gate must use the server-resolved account policy.'
  );
  assert.match(
    recurringSource.slice(recurringGate, vaultMutation),
    /if\s*\(\s*!threeDSecureVerification\.passed\s*\)/,
    'Failed recurring 3DS evidence must stop before vaulting.'
  );

  assert.match(
    gatewaySource,
    /threeDSecure:\s*{\s*required:\s*threeDSecureRequired\s*}/,
    'The gateway wrapper must map only the validated boolean into Braintree options.'
  );
});

test('gateway-specific Stage 1 currencies live only in dedicated configuration', () => {
  const allowedRuntimeFiles = new Set([
    'config/environment.js', // The existing storefront has its own configured currency.
    'config/demo-currency.js',
    'lib/demo/scenarios.js',
    'lib/three-d-secure.js',
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
