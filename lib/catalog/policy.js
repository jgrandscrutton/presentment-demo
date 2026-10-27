'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { deepFreeze } = require('./copies');

const DEFAULT_POLICIES_DIRECTORY = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'routing-policies'
);

function warning(code, message) {
  return Object.freeze({ code, message });
}

function safePolicyFilename(merchantId) {
  if (typeof merchantId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(merchantId)) {
    throw new TypeError('The configured Braintree merchant ID is invalid');
  }

  return `${merchantId}.json`;
}

async function loadRoutingPolicy({
  merchantId,
  policiesDirectory = DEFAULT_POLICIES_DIRECTORY,
} = {}) {
  const filename = safePolicyFilename(merchantId);
  const policyPath = path.join(policiesDirectory, filename);
  let contents;

  try {
    contents = await fs.readFile(policyPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        policy: null,
        source: 'missing',
        warnings: Object.freeze([
          warning(
            'POLICY_NOT_FOUND',
            `No routing policy was found for gateway ${merchantId}; automatic assignment is active.`
          ),
        ]),
      });
    }

    return Object.freeze({
      policy: null,
      source: 'unreadable',
      warnings: Object.freeze([
        warning(
          'POLICY_UNREADABLE',
          `The routing policy for gateway ${merchantId} could not be read; automatic assignment is active.`
        ),
      ]),
    });
  }

  let policy;
  try {
    policy = JSON.parse(contents);
  } catch {
    return Object.freeze({
      policy: null,
      source: 'invalid',
      warnings: Object.freeze([
        warning(
          'POLICY_INVALID_JSON',
          `The routing policy for gateway ${merchantId} is not valid JSON; automatic assignment is active.`
        ),
      ]),
    });
  }

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return Object.freeze({
      policy: null,
      source: 'invalid',
      warnings: Object.freeze([
        warning(
          'POLICY_INVALID',
          `The routing policy for gateway ${merchantId} is invalid; automatic assignment is active.`
        ),
      ]),
    });
  }

  if (policy.merchantId !== merchantId) {
    return Object.freeze({
      policy: null,
      source: 'mismatch',
      warnings: Object.freeze([
        warning(
          'POLICY_MERCHANT_ID_MISMATCH',
          `The routing policy does not match connected gateway ${merchantId}; the whole policy was ignored.`
        ),
      ]),
    });
  }

  return Object.freeze({
    policy: deepFreeze(structuredClone(policy)),
    source: 'loaded',
    warnings: Object.freeze([]),
  });
}

module.exports = {
  DEFAULT_POLICIES_DIRECTORY,
  loadRoutingPolicy,
  safePolicyFilename,
  warning,
};
