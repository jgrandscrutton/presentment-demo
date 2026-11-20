'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(value = '') {
    this.value = value;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.className = '';
    this.href = '';
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  async dispatch(type) {
    const handler = this.listeners.get(type);
    if (handler) {
      await handler({
        preventDefault() {},
        target: this,
        currentTarget: this,
      });
    }
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  reportValidity() {
    return true;
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function createClientHarness(paymentOutcome = 'route-mismatch', options = {}) {
  const ids = [
    'demo-payment-form',
    'scenario-id',
    'payment-type',
    'currency',
    'transaction-mode',
    'expected-outcome',
    'recurring-model',
    'recurring-options',
    'plan-field',
    'plan-id',
    'plan-availability',
    'merchant-managed-copy',
    'braintree-subscription-copy',
    'recurring-availability',
    'amount',
    'currency-prefix',
    'demo-rate',
    'sandbox-outcome-notice',
    'preview-route',
    'run-payment',
    'run-payment-label',
    'pay-step-copy',
    'payment-method-chooser',
    'payment-method-card',
    'payment-method-paypal',
    'payment-method-card-option',
    'payment-method-paypal-option',
    'payment-method-availability',
    'card-fields',
    'sandbox-card-hint',
    'dispute-card-hint',
    'three-d-secure-panel',
    'three-d-secure-policy-badge',
    'three-d-secure-policy-copy',
    'three-d-secure-optional-control',
    'three-d-secure-enabled',
    'three-d-secure-scenarios',
    'three-d-secure-card-number',
    'three-d-secure-status',
    'paypal-fields',
    'paypal-button',
    'paypal-flow-copy',
    'checkout-status',
    'recurring-notice',
    'recurring-notice-copy',
    'no-route-notice',
    'recurring-actions',
    'recurring-action-status',
    'run-next-cycle',
    'run-vault-one-time',
    'refresh-subscription',
    'cancel-subscription',
    'inspector-state',
    'intent-summary',
    'account-summary',
    'route-reason',
    'trace-count',
    'decision-trace',
    'request-json',
    'result-details',
    'result-json',
    'verification-card',
    'verification-icon',
    'verification-title',
    'verification-copy',
    'three-d-secure-proof',
    'three-d-secure-policy-proof',
    'three-d-secure-scope-proof',
    'three-d-secure-status-proof',
    'liability-shift-possible-proof',
    'liability-shifted-proof',
    'recurring-proof',
    'recurring-model-proof',
    'transaction-source-proof',
    'control-panel-link',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements['scenario-id'].value = 'gbp-one-time';
  elements['payment-type'].value = 'one_time';
  elements.currency.value = 'GBP';
  elements['transaction-mode'].value = 'submit_for_settlement';
  elements['expected-outcome'].value = 'approved';
  elements['recurring-model'].value = 'merchant_managed';
  elements['recurring-model'].options = [new FakeElement('merchant_managed'), new FakeElement('braintree_subscription')];
  elements['payment-method-card'].checked = true;
  elements['payment-method-paypal'].checked = false;
  elements['three-d-secure-enabled'].checked = true;
  elements.amount.value = '10.00';
  const threeDSecureScenarioOptions = [
    new FakeElement('frictionless'),
    new FakeElement('challenge'),
    new FakeElement('failed'),
  ];
  threeDSecureScenarioOptions[0].checked = true;
  elements.currency.options = [
    {
      value: 'GBP',
      dataset: {
        symbol: '£',
        minimum: '0.01',
        maximum: '1999.99',
        step: '0.01',
        demoAmount: '10.00',
        demoRate: '1 GBP = 1 GBP',
        processorDeclinedAmount: '2001.00',
        gatewayRejectedAmount: '5001.00',
      },
    },
    {
      value: 'JPY',
      dataset: {
        symbol: '¥',
        minimum: '1',
        maximum: '1999',
        step: '1',
        demoAmount: '237',
        demoRate: '1 GBP = 191 JPY',
        processorDeclinedAmount: '2001',
        gatewayRejectedAmount: '5001',
      },
    },
  ];
  const planPlaceholder = new FakeElement('');
  planPlaceholder.textContent = 'Select a discovered plan';
  const configuredPlans = options.planOptions === undefined
    ? [
        {
          id: 'gbp-monthly',
          currency: 'GBP',
          price: '10.00',
          label: 'GBP Monthly · 10.00 GBP · every 1 month',
        },
      ]
    : options.planOptions;
  const planElements = configuredPlans.map((plan) => {
    const option = new FakeElement(plan.id);
    option.dataset.currency = plan.currency;
    option.dataset.price = plan.price || '';
    option.textContent = plan.label || plan.id;
    return option;
  });
  elements['plan-id'].options = [planPlaceholder, ...planElements];
  elements['plan-id'].value = '';

  const route = {
    matched: true,
    intent: { currency: 'GBP', paymentType: 'one_time' },
    account: {
      key: 'gbp',
      label: 'UK Store – GBP',
      merchantAccountId: 'paypal2',
      paymentMethods: options.paymentMethods || ['card', 'paypal'],
      threeDSecurePolicy: options.threeDSecurePolicy || 'optional',
    },
    reason: 'GBP one-time payments use paypal2.',
    trace: [],
  };
  const safeRequest = {
    scenarioId: 'gbp-one-time',
    currency: 'GBP',
    paymentType: 'one_time',
    paymentMethod: 'card',
    transactionMode: 'submit_for_settlement',
    expectedOutcome: 'approved',
  };
  function routeFor(body = {}, paymentType = body?.paymentType || 'one_time') {
    const currency = body?.currency || 'GBP';
    const recurring = paymentType === 'recurring';
    return {
      matched: true,
      intent: { currency, paymentType },
      account: {
        key: recurring ? `${currency.toLowerCase()}-billing` : `${currency.toLowerCase()}-sale`,
        label: recurring ? `${currency} recurring account` : `${currency} one-time account`,
        merchantAccountId: recurring ? `${currency.toLowerCase()}-recurring` : 'paypal2',
        paymentMethods: options.paymentMethods || ['card', 'paypal'],
        threeDSecurePolicy: options.threeDSecurePolicy || 'optional',
      },
      reason: recurring
        ? `${currency} recurring billing uses its recurring route.`
        : `${currency} one-time payments use their purchase route.`,
      trace: [],
    };
  }

  function safeRequestFor(body = {}) {
    return {
      scenarioId: body.scenarioId || 'manual',
      currency: body.currency || 'GBP',
      paymentType: body.paymentType || 'one_time',
      paymentMethod: body.paymentMethod || 'card',
      transactionMode: body.transactionMode || 'submit_for_settlement',
      expectedOutcome: body.expectedOutcome || 'approved',
      ...(body.amount ? { amount: body.amount } : {}),
      ...(body.recurringModel ? { recurringModel: body.recurringModel } : {}),
      ...(body.planId ? { planId: body.planId } : {}),
    };
  }

  function threeDSecureVerificationFor(body = {}) {
    const policy = options.threeDSecurePolicy || 'optional';
    const applicable = body?.paymentMethod !== 'paypal';
    const nonce = body?.paymentMethodNonce || body?.nonce;
    const performed = applicable && nonce === 'three-d-secure-upgraded-reference';
    const required = applicable && policy === 'required';
    return {
      policy,
      applicable,
      required,
      performed,
      status: performed ? 'authenticate_successful' : null,
      liabilityShiftPossible: performed ? true : null,
      liabilityShifted: performed ? true : null,
      passed: !applicable || !required || performed,
      explanation: !applicable
        ? '3D Secure does not apply to PayPal.'
        : performed
          ? 'Braintree verified the upgraded card nonce and liability shift.'
          : 'Optional authentication was not performed.',
    };
  }

  function vaultSetupThreeDSecureVerificationFor(body = {}) {
    return {
      ...threeDSecureVerificationFor(body),
      evidenceScope: 'vault_setup',
      transactionAuthenticated: false,
    };
  }

  function unauthenticatedTransactionThreeDSecureVerificationFor(
    body = {},
    evidenceScope
  ) {
    const verification = threeDSecureVerificationFor(body);
    return {
      ...verification,
      performed: false,
      status: null,
      liabilityShiftPossible: null,
      liabilityShifted: null,
      passed: !verification.applicable || !verification.required,
      evidenceScope,
      transactionAuthenticated: false,
      explanation: 'No transaction-level 3D Secure authentication was recorded.',
    };
  }

  const calls = {
    preview: 0,
    token: 0,
    payment: 0,
    recurringStart: 0,
    nextCycle: 0,
    vaultOneTime: 0,
    subscriptionStatus: 0,
    subscriptionCancel: 0,
    hostedFields: 0,
    clientCreates: [],
    hostedFieldsCreates: [],
    threeDSecureCreates: [],
    threeDSecureVerifications: [],
    threeDSecureLookupCompletes: 0,
    threeDSecureTeardowns: 0,
    paypalCheckout: 0,
    paypalSdkLoads: 0,
    paypalLoadOptions: [],
    paypalButtons: 0,
    paypalRenders: 0,
    paypalCreates: [],
    paypalTokenizes: 0,
    paypalTeardowns: 0,
    paypalButtonCloses: 0,
    paypalButtonConfig: null,
    confirmations: [],
    refresh: 0,
    reload: 0,
    requests: [],
  };
  let recurringVaultThreeDSecureVerification = null;

  function catalogUnavailableResponse() {
    return response(503, {
      success: false,
      error: {
        code: 'CATALOG_UNAVAILABLE',
        message: 'Merchant account discovery is unavailable.',
      },
    });
  }

  async function fetch(url, request = {}) {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : null;
    calls.requests.push({ url, method: request.method || 'GET', body });
    if (url === '/api/demo/route-preview') {
      calls.preview += 1;
      if (options.catalogUnavailableAt === 'preview') {
        return catalogUnavailableResponse();
      }
      return response(200, {
        success: true,
        request: safeRequestFor(body),
        route: routeFor(body),
      });
    }
    if (url === '/api/demo/client-token') {
      calls.token += 1;
      if (options.catalogUnavailableAt === 'token') {
        return catalogUnavailableResponse();
      }
      return response(200, {
        success: true,
        clientToken: 'test-client-authorization',
        request: safeRequestFor(body),
        route: options.tokenRoute
          ? options.tokenRoute(routeFor(body), body)
          : routeFor(body),
      });
    }
    if (url === '/api/demo/catalog/refresh') {
      calls.refresh += 1;
      if (options.refreshOutcome === 'unavailable') {
        return response(503, {
          success: false,
          error: {
            code: 'CATALOG_UNAVAILABLE',
            message: 'Fresh discovery failed; the prior catalog was discarded.',
          },
          catalog: { status: 'failed' },
        });
      }
      if (options.refreshOutcome === 'network-error') {
        throw new Error('connection closed');
      }
      return response(200, { success: true, status: 'ok' });
    }
    if (url === '/api/demo/recurring/start') {
      calls.recurringStart += 1;
      const recurringModel = body?.recurringModel || 'merchant_managed';
      const recurringRoute = routeFor(body, 'recurring');
      const vaultThreeDSecureVerification =
        vaultSetupThreeDSecureVerificationFor(body);
      recurringVaultThreeDSecureVerification = vaultThreeDSecureVerification;
      const shared = {
        success: true,
        request: safeRequestFor(body),
        route: recurringRoute,
        verification: {
          passed: true,
          explanation: 'The recurring result matches the resolved account.',
        },
        threeDSecureVerification: recurringModel === 'braintree_subscription'
          ? unauthenticatedTransactionThreeDSecureVerificationFor(
              body,
              'subscription_transaction'
            )
          : vaultThreeDSecureVerification,
        auditEventId: recurringModel === 'braintree_subscription'
          ? 'subscription-event-1'
          : 'recurring-event-1',
        recurringModel,
        audit: { persisted: true },
      };
      if (recurringModel === 'braintree_subscription') {
        return response(200, {
          ...shared,
          subscription: {
            status: 'Active',
            nextBillingDate: '2026-11-27',
          },
          transactionSource: null,
          scheduleOwner: 'braintree',
          vaultThreeDSecureVerification,
        });
      }
      return response(200, {
        ...shared,
        braintreeResult: {
          transaction: {
            id: 'recurring-transaction-1',
            merchantAccountId: recurringRoute.account.merchantAccountId,
            status: 'submitted_for_settlement',
          },
        },
        transactionSource: 'recurring_first',
      });
    }

    const nextCycleMatch = url.match(
      /^\/api\/demo\/recurring\/events\/([^/]+)\/next-cycle$/
    );
    if (nextCycleMatch) {
      calls.nextCycle += 1;
      return response(200, {
        success: true,
        route: routeFor({ currency: 'GBP' }, 'recurring'),
        verification: { passed: true, explanation: 'Recurring route verified.' },
        threeDSecureVerification:
          recurringVaultThreeDSecureVerification ||
          vaultSetupThreeDSecureVerificationFor({ paymentMethod: 'card' }),
        braintreeResult: { transaction: { status: 'submitted_for_settlement' } },
        recurringModel: 'merchant_managed',
        transactionSource: 'recurring',
      });
    }

    const vaultOneTimeMatch = url.match(
      /^\/api\/demo\/recurring\/events\/([^/]+)\/one-time$/
    );
    if (vaultOneTimeMatch) {
      calls.vaultOneTime += 1;
      return response(200, {
        success: true,
        route: routeFor({ currency: 'GBP' }, 'one_time'),
        verification: { passed: true, explanation: 'One-time route verified.' },
        threeDSecureVerification:
          unauthenticatedTransactionThreeDSecureVerificationFor(
            { paymentMethod: 'card' },
            'vaulted_one_time_transaction'
          ),
        vaultThreeDSecureVerification:
          recurringVaultThreeDSecureVerification ||
          vaultSetupThreeDSecureVerificationFor({ paymentMethod: 'card' }),
        braintreeResult: { transaction: { status: 'submitted_for_settlement' } },
        recurringModel: 'merchant_managed',
        transactionSource: null,
        vaultUsage: 'one_time_from_vault',
      });
    }

    const subscriptionCancelMatch = url.match(
      /^\/api\/demo\/recurring\/subscriptions\/([^/]+)\/cancel$/
    );
    if (subscriptionCancelMatch) {
      calls.subscriptionCancel += 1;
      return response(200, {
        success: true,
        subscription: { status: 'Canceled' },
        verification: { passed: true, actualPaymentMethod: 'card' },
        recurringModel: 'braintree_subscription',
        transactionSource: null,
        scheduleOwner: 'braintree',
        threeDSecureVerification:
          unauthenticatedTransactionThreeDSecureVerificationFor(
            { paymentMethod: 'card' },
            'subscription_transaction'
          ),
        vaultThreeDSecureVerification:
          recurringVaultThreeDSecureVerification ||
          vaultSetupThreeDSecureVerificationFor({ paymentMethod: 'card' }),
      });
    }

    const subscriptionStatusMatch = url.match(
      /^\/api\/demo\/recurring\/subscriptions\/([^/]+)$/
    );
    if (subscriptionStatusMatch) {
      calls.subscriptionStatus += 1;
      return response(200, {
        success: true,
        verification: { passed: true, actualPaymentMethod: 'card' },
        subscription: {
          status: options.subscriptionStatus || 'Active',
          nextBillingDate: '2026-11-27',
        },
        recurringModel: 'braintree_subscription',
        transactionSource: null,
        scheduleOwner: 'braintree',
        threeDSecureVerification:
          unauthenticatedTransactionThreeDSecureVerificationFor(
            { paymentMethod: 'card' },
            'subscription_transaction'
          ),
        vaultThreeDSecureVerification:
          recurringVaultThreeDSecureVerification ||
          vaultSetupThreeDSecureVerificationFor({ paymentMethod: 'card' }),
        controlPanelUrl:
          'https://sandbox.braintreegateway.com/merchants/test/subscriptions/subscription-1',
      });
    }
    if (url !== '/api/demo/payments/one-time') {
      throw new Error(`Unexpected URL: ${url}`);
    }

    calls.payment += 1;
    if (options.catalogUnavailableAt === 'payment') {
      return catalogUnavailableResponse();
    }
    if (paymentOutcome === 'network-error') {
      throw new Error('connection closed');
    }
    if (paymentOutcome === 'gateway-error') {
      return response(502, {
        success: false,
        error: {
          code: 'BRAINTREE_REQUEST_FAILED',
          message: 'Braintree did not return a usable result.',
        },
        request: safeRequest,
        route,
        audit: { persisted: true },
      });
    }
    if (paymentOutcome === 'inspection-unavailable') {
      return response(502, {
        success: false,
        error: {
          code: 'PAYMENT_METHOD_INSPECTION_FAILED',
          message: 'Braintree could not verify the payment method. No transaction was requested.',
        },
        request: safeRequestFor(body),
        route,
        retrySafe: true,
      });
    }

    const transactionResult = {
      transaction: {
        id: 'transaction-1',
        status: paymentOutcome === 'authorized' ? 'authorized' :
          paymentOutcome === 'expected-decline' ? 'processor_declined' :
            'submitted_for_settlement',
        amount: body?.amount || '10.00',
        currencyIsoCode: 'GBP',
        merchantAccountId:
          paymentOutcome === 'route-mismatch' ? 'vmUSD' : 'paypal2',
      },
    };

    if (paymentOutcome === 'authorized') {
      return response(200, {
        success: true,
        paymentApproved: true,
        request: {
          ...safeRequestFor(body),
          transactionMode: 'authorize_only',
          amount: body?.amount,
        },
        route,
        braintreeResult: transactionResult,
        transactionStatus: 'authorized',
        demoOutcome: { expected: 'approved', actual: 'approved', matched: true },
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        currencyVerification: {
          passed: true,
          explanation: 'The returned currency matches.',
        },
        paymentMethodVerification: {
          passed: true,
          actualPaymentMethod: body?.paymentMethod || 'card',
          explanation: 'The returned payment method matches.',
        },
        threeDSecureVerification: threeDSecureVerificationFor(body),
        audit: { persisted: true },
      });
    }

    if (paymentOutcome === 'expected-decline') {
      return response(200, {
        success: true,
        paymentApproved: false,
        request: {
          ...safeRequest,
          expectedOutcome: 'processor_declined',
          amount: body?.amount,
        },
        route,
        braintreeResult: transactionResult,
        transactionStatus: 'processor_declined',
        demoOutcome: {
          expected: 'processor_declined',
          actual: 'processor_declined',
          matched: true,
        },
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        threeDSecureVerification: threeDSecureVerificationFor(body),
        audit: { persisted: true },
      });
    }

    if (paymentOutcome === 'audit-warning') {
      return response(200, {
        success: true,
        request: safeRequest,
        route,
        braintreeResult: transactionResult,
        verification: {
          passed: true,
          explanation: 'The returned merchant account matches.',
        },
        threeDSecureVerification: threeDSecureVerificationFor(body),
        audit: {
          persisted: false,
          warning: 'The transaction completed, but its audit event was not saved. Do not retry.',
        },
      });
    }

    return response(502, {
      success: false,
      error: {
        code: 'ROUTE_VERIFICATION_FAILED',
        message: 'A transaction was returned on another account. Do not retry.',
      },
      request: safeRequest,
      route,
      braintreeResult: transactionResult,
      verification: {
        passed: false,
        explanation: 'Expected paypal2 but Braintree returned vmUSD.',
      },
      threeDSecureVerification: threeDSecureVerificationFor(body),
      audit: { persisted: true },
      controlPanelUrl:
        'https://sandbox.braintreegateway.com/merchants/test/transactions/transaction-1',
    });
  }

  const refreshButton = new FakeElement();
  const refreshStatus = new FakeElement();
  const staleCatalogContent = [new FakeElement(), new FakeElement()];
  const runnerSteps = ['choose', 'preview', 'pay', 'verify'].map((name) => {
    const step = new FakeElement();
    step.dataset.runnerStep = name;
    return step;
  });
  const document = {
    body: {
      dataset: {
        catalogAvailable: options.catalogAvailable === false ? 'false' : 'true',
      },
    },
    querySelector(selector) {
      return elements[selector.slice(1)] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-catalog-refresh]') return [refreshButton];
      if (selector === '[data-refresh-status]') return [refreshStatus];
      if (selector === '[data-catalog-stale-content]') return staleCatalogContent;
      if (selector === '[data-runner-step]') return runnerSteps;
      if (selector === 'input[name="threeDSecureScenario"]') {
        return threeDSecureScenarioOptions;
      }
      return [];
    },
    createElement() {
      return new FakeElement();
    },
  };
  const window = {
    confirm(message) {
      calls.confirmations.push(message);
      return options.confirmCancellation !== false;
    },
    location: {
      reload() {
        calls.reload += 1;
      },
    },
    braintree: {
      client: {
        async create(createOptions) {
          const client = { id: `client-${calls.clientCreates.length + 1}` };
          calls.clientCreates.push({
            options: structuredClone(createOptions),
            client,
          });
          return client;
        },
      },
      hostedFields: {
        async create(createOptions) {
          calls.hostedFields += 1;
          calls.hostedFieldsCreates.push(createOptions);
          return {
            async tokenize() {
              return {
                nonce: 'test-payment-method-reference',
                details: { bin: '400000' },
              };
            },
            async teardown() {},
          };
        },
      },
      threeDSecure: {
        async create(createOptions) {
          if (options.threeDSecureCreateError) {
            throw new Error('3D Secure setup failed.');
          }
          calls.threeDSecureCreates.push(createOptions);
          return {
            async verifyCard(verificationOptions) {
              const recorded = {
                amount: verificationOptions.amount,
                nonce: verificationOptions.nonce,
                bin: verificationOptions.bin,
                collectDeviceData: verificationOptions.collectDeviceData,
                hasOnLookupComplete:
                  typeof verificationOptions.onLookupComplete === 'function',
              };
              calls.threeDSecureVerifications.push(recorded);
              if (typeof verificationOptions.onLookupComplete === 'function') {
                verificationOptions.onLookupComplete({}, () => {
                  calls.threeDSecureLookupCompletes += 1;
                });
              }
              if (options.threeDSecureVerifyError) {
                throw new Error('Issuer authentication was canceled.');
              }
              if (options.threeDSecureDeferred) {
                options.threeDSecureDeferred.started = true;
                return new Promise((resolve, reject) => {
                  options.threeDSecureDeferred.resolve = resolve;
                  options.threeDSecureDeferred.reject = reject;
                });
              }
              return options.threeDSecureResult || {
                nonce: 'three-d-secure-upgraded-reference',
                liabilityShiftPossible: true,
                liabilityShifted: true,
              };
            },
            async teardown() {
              calls.threeDSecureTeardowns += 1;
            },
          };
        },
      },
      paypalCheckout: {
        async create() {
          calls.paypalCheckout += 1;
          return {
            async loadPayPalSDK(loadOptions) {
              calls.paypalSdkLoads += 1;
              calls.paypalLoadOptions.push(structuredClone(loadOptions));
              const namespace = loadOptions?.dataAttributes?.namespace;
              window[namespace] = {
                Buttons(buttonConfig) {
                  calls.paypalButtons += 1;
                  calls.paypalButtonConfig = buttonConfig;
                  return {
                    isEligible() {
                      return options.paypalEligible !== false;
                    },
                    async render() {
                      calls.paypalRenders += 1;
                    },
                    async close() {
                      calls.paypalButtonCloses += 1;
                    },
                  };
                },
              };
            },
            async createPayment(createOptions) {
              calls.paypalCreates.push(structuredClone(createOptions));
              return createOptions.flow === 'vault'
                ? 'sandbox-billing-token'
                : 'sandbox-order-id';
            },
            async tokenizePayment() {
              calls.paypalTokenizes += 1;
              if (options.paypalTokenizeError) {
                throw new Error('PayPal tokenization failed safely.');
              }
              return { nonce: 'test-paypal-payment-method-reference' };
            },
            async teardown() {
              calls.paypalTeardowns += 1;
            },
          };
        },
      },
    },
  };
  if (options.threeDSecureAvailable === false) {
    delete window.braintree.threeDSecure;
  }

  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'scripts', 'demo.js'),
    'utf8'
  );
  vm.runInNewContext(script, { document, window, fetch, console });

  return {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
    runnerSteps,
    threeDSecureScenarioOptions,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for the demo client state');
}

async function choosePayPal(harness) {
  harness.elements['payment-method-card'].checked = false;
  harness.elements['payment-method-paypal'].checked = true;
  await harness.elements['payment-method-paypal'].dispatch('change');
  await waitFor(() => harness.calls.paypalRenders > 0);
}

test('method chooser exposes only policy-enabled methods for the resolved account', async () => {
  const cardOnly = createClientHarness('authorized', {
    paymentMethods: ['card'],
  });
  await waitFor(() => cardOnly.calls.hostedFields === 1);

  assert.equal(cardOnly.elements['payment-method-paypal-option'].hidden, true);
  assert.equal(cardOnly.elements['payment-method-paypal'].disabled, true);
  assert.match(
    cardOnly.elements['payment-method-availability'].textContent,
    /only enabled method/i
  );
  assert.equal(cardOnly.calls.paypalCheckout, 0);

  const both = createClientHarness('authorized');
  await waitFor(() => both.calls.hostedFields === 1);
  assert.equal(both.elements['payment-method-paypal-option'].hidden, false);
  assert.equal(both.elements['payment-method-paypal'].disabled, false);
  assert.match(
    both.elements['payment-method-availability'].textContent,
    /Card and PayPal/i
  );
});

test('required 3D Secure shares the Hosted Fields client and submits only the upgraded nonce', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecurePolicy: 'required',
  });
  await waitFor(() =>
    harness.calls.hostedFields === 1 &&
    harness.calls.threeDSecureCreates.length === 1 &&
    !harness.elements['run-payment'].disabled
  );

  const hostedFieldsOptions = harness.calls.hostedFieldsCreates[0];
  const threeDSecureOptions = harness.calls.threeDSecureCreates[0];
  assert.equal(harness.calls.clientCreates.length, 1);
  assert.equal(hostedFieldsOptions.client, threeDSecureOptions.client);
  assert.equal(
    hostedFieldsOptions.client,
    harness.calls.clientCreates[0].client
  );
  assert.equal(threeDSecureOptions.version, 2);
  assert.equal(harness.elements['three-d-secure-panel'].hidden, false);
  assert.match(
    harness.elements['three-d-secure-policy-badge'].textContent,
    /Required/
  );

  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.deepEqual(harness.calls.threeDSecureVerifications, [
    {
      amount: '10.00',
      nonce: 'test-payment-method-reference',
      bin: '400000',
      collectDeviceData: true,
      hasOnLookupComplete: true,
    },
  ]);
  assert.equal(harness.calls.threeDSecureLookupCompletes, 1);
  assert.equal(harness.calls.payment, 1);
  const paymentRequest = harness.calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(
    paymentRequest.body.paymentMethodNonce,
    'three-d-secure-upgraded-reference'
  );
  for (const untrustedField of [
    'threeDSecurePolicy',
    'threeDSecureVerification',
    'liabilityShiftPossible',
    'liabilityShifted',
  ]) {
    assert.equal(Object.hasOwn(paymentRequest.body, untrustedField), false);
  }
  assert.equal(
    harness.elements['verification-title'].textContent,
    'Route + card + 3D Secure verified'
  );
  assert.equal(harness.elements['three-d-secure-policy-proof'].textContent, 'Required');
  assert.equal(
    harness.elements['three-d-secure-status-proof'].textContent,
    'Authenticated'
  );
  assert.equal(harness.elements['liability-shift-possible-proof'].textContent, 'Yes');
  assert.equal(harness.elements['liability-shifted-proof'].textContent, 'Yes');
  assert.equal(
    harness.elements['demo-payment-form'].attributes.has('aria-busy'),
    false
  );
});

test('optional 3D Secure can be switched off without posting an authority claim', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() =>
    harness.calls.hostedFields === 1 &&
    harness.calls.threeDSecureCreates.length === 1 &&
    !harness.elements['run-payment'].disabled
  );

  harness.elements['three-d-secure-enabled'].checked = false;
  await harness.elements['three-d-secure-enabled'].dispatch('change');
  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.equal(harness.calls.threeDSecureVerifications.length, 0);
  assert.equal(harness.calls.payment, 1);
  const paymentRequest = harness.calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(
    paymentRequest.body.paymentMethodNonce,
    'test-payment-method-reference'
  );
  assert.equal(Object.hasOwn(paymentRequest.body, 'threeDSecurePolicy'), false);
  assert.equal(Object.hasOwn(paymentRequest.body, 'liabilityShifted'), false);
  assert.equal(harness.elements['three-d-secure-policy-proof'].textContent, 'Optional');
  assert.equal(
    harness.elements['three-d-secure-status-proof'].textContent,
    'Not performed'
  );
});

test('a resolved failed authentication stops before payment on an optional route', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecureResult: {
      nonce: 'failed-three-d-secure-reference',
      liabilityShiftPossible: true,
      liabilityShifted: false,
    },
  });
  await waitFor(() =>
    harness.calls.hostedFields === 1 &&
    harness.calls.threeDSecureCreates.length === 1 &&
    !harness.elements['run-payment'].disabled
  );

  harness.threeDSecureScenarioOptions[0].checked = false;
  harness.threeDSecureScenarioOptions[2].checked = true;
  await harness.threeDSecureScenarioOptions[2].dispatch('change');
  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.equal(harness.calls.threeDSecureVerifications.length, 1);
  assert.equal(harness.calls.payment, 0);
  assert.equal(harness.elements['inspector-state'].textContent, 'Authentication stopped');
  assert.match(harness.elements['checkout-status'].textContent, /failed as selected/i);
  assert.match(harness.elements['checkout-status'].textContent, /No payment request was sent/i);
});

test('selecting the failed scenario cannot submit a card that authenticated successfully', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() =>
    harness.calls.hostedFields === 1 &&
    harness.calls.threeDSecureCreates.length === 1 &&
    !harness.elements['run-payment'].disabled
  );

  harness.threeDSecureScenarioOptions[0].checked = false;
  harness.threeDSecureScenarioOptions[2].checked = true;
  await harness.threeDSecureScenarioOptions[2].dispatch('change');
  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.equal(harness.calls.threeDSecureVerifications.length, 1);
  assert.equal(harness.calls.payment, 0);
  assert.equal(harness.calls.recurringStart, 0);
  assert.equal(harness.elements['run-payment'].disabled, false);
  assert.match(harness.elements['checkout-status'].textContent, /authenticated.*successfully/i);
  assert.match(harness.elements['checkout-status'].textContent, /failure test card/i);
  assert.match(harness.elements['checkout-status'].textContent, /No payment request was sent/i);
});

test('changing 3D Secure controls clears proof from the prior transaction', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() =>
    harness.calls.hostedFields === 1 &&
    harness.calls.threeDSecureCreates.length === 1 &&
    !harness.elements['run-payment'].disabled
  );

  await harness.elements['demo-payment-form'].dispatch('submit');
  assert.equal(harness.elements['verification-card'].hidden, false);
  assert.equal(harness.elements['three-d-secure-proof'].hidden, false);

  harness.elements['three-d-secure-enabled'].checked = false;
  await harness.elements['three-d-secure-enabled'].dispatch('change');
  assert.equal(harness.elements['verification-card'].hidden, true);
  assert.equal(harness.elements['three-d-secure-proof'].hidden, true);
  assert.equal(harness.elements['result-json'].textContent, 'No transaction has been sent.');

  harness.elements['verification-card'].hidden = false;
  harness.elements['three-d-secure-proof'].hidden = false;
  harness.elements['result-json'].textContent = '{"stale":true}';
  harness.threeDSecureScenarioOptions[0].checked = false;
  harness.threeDSecureScenarioOptions[1].checked = true;
  await harness.threeDSecureScenarioOptions[1].dispatch('change');
  assert.equal(harness.elements['verification-card'].hidden, true);
  assert.equal(harness.elements['three-d-secure-proof'].hidden, true);
  assert.equal(harness.elements['result-json'].textContent, 'No transaction has been sent.');
});

test('3D Secure authentication failure stops before payment and clears the busy state', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecurePolicy: 'required',
    threeDSecureVerifyError: true,
  });
  await waitFor(() =>
    harness.calls.hostedFields === 1 && !harness.elements['run-payment'].disabled
  );

  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.equal(harness.calls.threeDSecureVerifications.length, 1);
  assert.equal(harness.calls.payment, 0);
  assert.equal(harness.calls.recurringStart, 0);
  assert.equal(harness.elements['run-payment'].disabled, false);
  assert.equal(
    harness.elements['demo-payment-form'].attributes.has('aria-busy'),
    false
  );
  assert.equal(
    harness.elements['three-d-secure-status'].textContent,
    'Authentication stopped before payment.'
  );
  assert.equal(
    harness.elements['three-d-secure-status'].dataset.state,
    'failed'
  );
  assert.equal(
    harness.elements['inspector-state'].textContent,
    'Authentication stopped'
  );
  assert.match(
    harness.elements['checkout-status'].textContent,
    /No payment request was sent/i
  );
});

test('a stale 3D Secure challenge cannot submit its upgraded nonce on a newer route', async () => {
  const deferred = {};
  const harness = createClientHarness('authorized', {
    threeDSecurePolicy: 'required',
    threeDSecureDeferred: deferred,
  });
  await waitFor(() =>
    harness.calls.hostedFields === 1 && !harness.elements['run-payment'].disabled
  );

  const submission = harness.elements['demo-payment-form'].dispatch('submit');
  await waitFor(() => deferred.started === true);
  assert.equal(
    harness.elements['demo-payment-form'].attributes.get('aria-busy'),
    'true'
  );

  harness.elements.currency.value = 'JPY';
  await harness.elements.currency.dispatch('change');
  await waitFor(() =>
    harness.calls.preview >= 2 && harness.calls.threeDSecureTeardowns >= 1
  );
  deferred.resolve({
    nonce: 'stale-three-d-secure-reference',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  });
  await submission;

  assert.equal(harness.calls.payment, 0);
  assert.equal(harness.calls.recurringStart, 0);
  assert.ok(harness.calls.threeDSecureTeardowns >= 1);
  assert.equal(
    harness.elements['demo-payment-form'].attributes.has('aria-busy'),
    false
  );
  assert.match(harness.elements['checkout-status'].textContent, /older route/i);
});

test('a required route fails closed when the 3D Secure SDK is unavailable', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecurePolicy: 'required',
    threeDSecureAvailable: false,
  });
  await waitFor(() =>
    harness.elements['inspector-state'].textContent === '3DS unavailable'
  );

  assert.equal(harness.calls.token, 0);
  assert.equal(harness.calls.hostedFields, 0);
  assert.equal(harness.calls.threeDSecureCreates.length, 0);
  assert.equal(harness.elements['run-payment'].disabled, true);
  assert.equal(harness.elements['three-d-secure-panel'].hidden, false);
  assert.match(
    harness.elements['three-d-secure-status'].textContent,
    /Required authentication is unavailable/i
  );
  assert.match(
    harness.elements['checkout-status'].textContent,
    /requires 3D Secure/i
  );
});

test('a required route fails closed when the 3D Secure component cannot initialize', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecurePolicy: 'required',
    threeDSecureCreateError: true,
  });
  await waitFor(() =>
    harness.elements['inspector-state'].textContent === '3DS setup failed'
  );

  assert.equal(harness.calls.token, 1);
  assert.equal(harness.calls.hostedFields, 0);
  assert.equal(harness.calls.payment, 0);
  assert.equal(harness.elements['run-payment'].disabled, true);
  assert.equal(harness.elements['three-d-secure-status'].dataset.state, 'failed');
  assert.match(
    harness.elements['checkout-status'].textContent,
    /authentication component could not be initialized/i
  );
});

test('an optional 3D Secure initialization failure falls back to plain card checkout', async () => {
  const harness = createClientHarness('authorized', {
    threeDSecureCreateError: true,
  });
  await waitFor(() =>
    harness.calls.hostedFields === 1 && !harness.elements['run-payment'].disabled
  );

  assert.equal(harness.elements['three-d-secure-enabled'].checked, false);
  assert.equal(harness.elements['three-d-secure-status'].dataset.state, 'unavailable');
  assert.match(
    harness.elements['three-d-secure-status'].textContent,
    /Optional authentication is unavailable/i
  );

  await harness.elements['demo-payment-form'].dispatch('submit');
  assert.equal(harness.calls.threeDSecureVerifications.length, 0);
  assert.equal(harness.calls.payment, 1);
  const paymentRequest = harness.calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(paymentRequest.body.paymentMethodNonce, 'test-payment-method-reference');
});

test('PayPal one-time checkout stays Braintree-mediated and submits its declared method', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1);

  harness.elements['expected-outcome'].value = 'processor_declined';
  await choosePayPal(harness);

  assert.equal(harness.elements['expected-outcome'].value, 'approved');
  assert.equal(harness.elements['expected-outcome'].disabled, true);
  assert.equal(harness.elements['card-fields'].hidden, true);
  assert.equal(harness.elements['three-d-secure-panel'].hidden, true);
  assert.equal(harness.elements['paypal-fields'].hidden, false);
  assert.equal(harness.elements['run-payment'].hidden, true);
  assert.equal(harness.calls.paypalCheckout, 1);
  assert.equal(harness.calls.paypalSdkLoads, 1);
  assert.equal(harness.calls.paypalLoadOptions[0].currency, 'GBP');
  assert.equal(harness.calls.paypalLoadOptions[0].intent, 'capture');
  assert.match(
    harness.calls.paypalLoadOptions[0].dataAttributes.namespace,
    /^PhonePalPayPal_/
  );

  await harness.calls.paypalButtonConfig.createOrder();
  assert.deepEqual(harness.calls.paypalCreates[0], {
    flow: 'checkout',
    amount: '10.00',
    currency: 'GBP',
    intent: 'capture',
  });
  await harness.calls.paypalButtonConfig.onApprove({
    orderID: 'sandbox-order-id',
    payerID: 'sandbox-payer',
  });

  const paymentRequest = harness.calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(harness.calls.paypalTokenizes, 1);
  assert.equal(harness.calls.threeDSecureVerifications.length, 0);
  assert.ok(harness.calls.threeDSecureTeardowns >= 1);
  assert.equal(paymentRequest.body.paymentMethod, 'paypal');
  assert.equal(
    paymentRequest.body.paymentMethodNonce,
    'test-paypal-payment-method-reference'
  );
  assert.equal(Object.hasOwn(paymentRequest.body, 'merchantAccountId'), false);
  assert.equal(
    harness.elements['verification-title'].textContent,
    'Route + payment method verified'
  );
  assert.match(harness.elements['verification-copy'].textContent, /PayPal/);
});

test('PayPal setup is reused by configuration and cancel remains safely retryable', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1);
  await choosePayPal(harness);

  const firstButtonConfig = harness.calls.paypalButtonConfig;
  await firstButtonConfig.createOrder();
  firstButtonConfig.onCancel();
  assert.equal(harness.calls.payment, 0);
  assert.match(harness.elements['checkout-status'].textContent, /canceled/i);
  assert.equal(harness.elements.currency.disabled, false);

  harness.elements['payment-method-paypal'].checked = false;
  harness.elements['payment-method-card'].checked = true;
  await harness.elements['payment-method-card'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 2);
  await choosePayPal(harness);
  await waitFor(() => harness.calls.paypalRenders === 2);

  assert.equal(harness.calls.paypalCheckout, 2);
  assert.equal(harness.calls.paypalSdkLoads, 1);
  assert.ok(harness.calls.paypalTeardowns >= 1);
  assert.ok(harness.calls.paypalButtonCloses >= 1);
});

test('PayPal authorize intent matches SDK setup and Braintree payment creation', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1);

  harness.elements['transaction-mode'].value = 'authorize_only';
  await harness.elements['transaction-mode'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 2);
  await choosePayPal(harness);

  assert.equal(harness.calls.paypalLoadOptions.at(-1).intent, 'authorize');
  await harness.calls.paypalButtonConfig.createOrder();
  assert.equal(harness.calls.paypalCreates.at(-1).intent, 'authorize');
  harness.calls.paypalButtonConfig.onCancel();
});

test('stale PayPal callbacks and tokenization errors stop before the server', async () => {
  const stale = createClientHarness('authorized');
  await waitFor(() => stale.calls.hostedFields === 1);
  await choosePayPal(stale);
  const staleConfig = stale.calls.paypalButtonConfig;

  stale.elements['transaction-mode'].value = 'authorize_only';
  await stale.elements['transaction-mode'].dispatch('change');
  await waitFor(() => stale.calls.paypalRenders === 2);
  assert.throws(
    () => staleConfig.createOrder(),
    /no longer current/i
  );
  await staleConfig.onApprove({ orderID: 'stale-order' });
  assert.equal(stale.calls.paypalTokenizes, 0);
  assert.equal(stale.calls.payment, 0);
  assert.match(stale.elements['checkout-status'].textContent, /older route/i);

  const failedTokenization = createClientHarness('authorized', {
    paypalTokenizeError: true,
  });
  await waitFor(() => failedTokenization.calls.hostedFields === 1);
  await choosePayPal(failedTokenization);
  await failedTokenization.calls.paypalButtonConfig.createOrder();
  await failedTokenization.calls.paypalButtonConfig.onApprove({
    orderID: 'sandbox-order-id',
  });
  assert.equal(failedTokenization.calls.payment, 0);
  assert.match(
    failedTokenization.elements['checkout-status'].textContent,
    /tokenization failed safely/i
  );
});

test('PayPal vault flow uses a billing agreement and hides card-only vault follow-up', async () => {
  const harness = createClientHarness('route-mismatch');
  await waitFor(() => harness.calls.hostedFields === 1);

  harness.elements['payment-type'].value = 'recurring';
  await harness.elements['payment-type'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 2);
  await choosePayPal(harness);

  assert.equal(harness.calls.paypalLoadOptions.at(-1).vault, true);
  assert.equal(harness.calls.paypalLoadOptions.at(-1).intent, 'tokenize');
  assert.equal(
    typeof harness.calls.paypalButtonConfig.createBillingAgreement,
    'function'
  );
  assert.equal(harness.calls.paypalButtonConfig.createOrder, undefined);

  await harness.calls.paypalButtonConfig.createBillingAgreement();
  assert.deepEqual(harness.calls.paypalCreates.at(-1), {
    flow: 'vault',
    billingAgreementDescription: 'PhonePal Sandbox recurring billing agreement',
  });
  await harness.calls.paypalButtonConfig.onApprove({
    billingToken: 'sandbox-billing-token',
  });

  const startRequest = harness.calls.requests.findLast(
    (request) => request.url === '/api/demo/recurring/start'
  );
  assert.equal(startRequest.body.paymentMethod, 'paypal');
  assert.equal(startRequest.body.nonce, 'test-paypal-payment-method-reference');
  assert.equal(harness.elements['run-vault-one-time'].hidden, true);
  assert.match(
    harness.elements['recurring-action-status'].textContent,
    /vaulted PayPal account/i
  );
});

test('runner progress advances from route preview to card entry and verification', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1);

  const [choose, preview, pay, verify] = harness.runnerSteps;
  assert.equal(choose.classList.values.has('is-complete'), true);
  assert.equal(preview.classList.values.has('is-complete'), true);
  assert.equal(pay.classList.values.has('is-current'), true);
  assert.equal(pay.attributes.get('aria-current'), 'step');
  assert.equal(verify.classList.values.has('is-current'), false);

  await harness.elements['demo-payment-form'].dispatch('submit');

  assert.equal(pay.classList.values.has('is-complete'), true);
  assert.equal(pay.classList.values.has('is-current'), false);
  assert.equal(verify.classList.values.has('is-current'), true);
  assert.equal(verify.attributes.get('aria-current'), 'step');
});

test('route mismatch blocks implicit resubmission until Hosted Fields is rebuilt by a fresh preview', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.payment, 1);
  assert.equal(elements['run-payment'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /Do not retry/i);

  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.payment, 1);
  assert.match(elements['checkout-status'].textContent, /fresh route preview/i);

  await elements['preview-route'].dispatch('click');
  assert.equal(calls.hostedFields, 2);
  assert.equal(elements['run-payment'].disabled, false);
});

test('ambiguous or unaudited payment outcomes require a fresh preview before resubmission', async (t) => {
  for (const outcome of ['gateway-error', 'network-error', 'audit-warning']) {
    await t.test(outcome, async () => {
      const { calls, elements } = createClientHarness(outcome);
      await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

      await elements['demo-payment-form'].dispatch('submit');
      assert.equal(calls.payment, 1);
      assert.equal(elements['run-payment'].disabled, true);
      assert.match(elements['checkout-status'].textContent, /Do not retry/i);

      await elements['demo-payment-form'].dispatch('submit');
      assert.equal(calls.payment, 1);
    });
  }
});

test('a pre-sale inspection outage stays safely retryable without rebuilding the route', async () => {
  const { calls, elements } = createClientHarness('inspection-unavailable');
  await waitFor(() => calls.hostedFields === 1);

  await elements['demo-payment-form'].dispatch('submit');

  assert.equal(calls.payment, 1);
  assert.match(elements['checkout-status'].textContent, /No transaction was requested/);
  assert.doesNotMatch(elements['checkout-status'].textContent, /Do not retry/);
  assert.equal(elements['run-payment'].disabled, false);

  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.payment, 2);
});

test('currency changes apply discovered precision, range, symbol, and fixed demo amount', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1);

  elements.currency.value = 'JPY';
  await elements.currency.dispatch('change');

  assert.equal(elements.amount.min, '1');
  assert.equal(elements.amount.max, '1999');
  assert.equal(elements.amount.step, '1');
  assert.equal(elements.amount.value, '237');
  assert.equal(elements['currency-prefix'].textContent, '¥');
  assert.equal(elements['demo-rate'].textContent, '1 GBP = 191 JPY');
  assert.equal(elements.amount.attributes.get('inputmode'), 'numeric');
  assert.equal(calls.preview, 2);
});

test('sandbox failure choices lock the exact per-currency trigger amount and are labelled as non-FX', async () => {
  const { calls, elements } = createClientHarness('expected-decline');
  await waitFor(() => calls.hostedFields === 1);

  elements['expected-outcome'].value = 'processor_declined';
  await elements['expected-outcome'].dispatch('change');

  assert.equal(elements.amount.value, '2001.00');
  assert.equal(elements.amount.min, '2001.00');
  assert.equal(elements.amount.max, '2001.00');
  assert.equal(elements.amount.readOnly, true);
  assert.equal(elements['sandbox-outcome-notice'].hidden, false);
  assert.match(elements['demo-rate'].textContent, /Sandbox trigger · not demo FX/);
  assert.match(elements['run-payment-label'].textContent, /processor decline/i);

  elements.currency.value = 'JPY';
  await elements.currency.dispatch('change');
  assert.equal(elements.amount.value, '2001');
  assert.equal(elements.amount.step, '1');

  elements.currency.value = 'GBP';
  await elements.currency.dispatch('change');
  await elements['demo-payment-form'].dispatch('submit');

  const paymentRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(paymentRequest.body.expectedOutcome, 'processor_declined');
  assert.equal(paymentRequest.body.amount, '2001.00');
  assert.match(elements['checkout-status'].textContent, /observed as expected/i);
  assert.match(elements['checkout-status'].textContent, /No payment was approved/i);

  elements['expected-outcome'].value = 'approved';
  await elements['expected-outcome'].dispatch('change');
  assert.equal(elements.amount.value, '10.00');
  assert.equal(elements.amount.readOnly, false);
  assert.equal(elements['sandbox-outcome-notice'].hidden, true);
  assert.equal(elements['demo-rate'].textContent, '1 GBP = 1 GBP');
});

test('authorize-only is included in request state and reports an authorization distinctly', async () => {
  const { calls, elements } = createClientHarness('authorized');
  await waitFor(() => calls.hostedFields === 1);

  elements['transaction-mode'].value = 'authorize_only';
  await elements['transaction-mode'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  assert.match(elements['run-payment-label'].textContent, /Authorize sandbox/i);

  await elements['demo-payment-form'].dispatch('submit');
  const paymentRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/payments/one-time'
  );
  assert.equal(paymentRequest.body.transactionMode, 'authorize_only');
  assert.equal(elements['inspector-state'].textContent, 'Authorized');
  assert.match(elements['checkout-status'].textContent, /authorization created/i);
});

test('Model A vaults once, starts the first cycle, and follows up using only the audit event path', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1);

  elements['transaction-mode'].value = 'authorize_only';
  elements['expected-outcome'].value = 'processor_declined';
  elements.amount.value = '2001.00';
  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2 && !elements['run-payment'].disabled);

  assert.equal(elements['transaction-mode'].value, 'submit_for_settlement');
  assert.equal(elements['transaction-mode'].disabled, true);
  assert.equal(elements['expected-outcome'].value, 'approved');
  assert.equal(elements['expected-outcome'].disabled, true);
  assert.equal(elements.amount.value, '10.00');
  assert.equal(elements['recurring-options'].hidden, false);
  assert.equal(elements['recurring-notice'].hidden, false);
  assert.equal(elements['merchant-managed-copy'].hidden, false);
  assert.equal(elements['braintree-subscription-copy'].hidden, true);
  assert.match(elements['run-payment-label'].textContent, /first billing cycle/i);

  await elements['demo-payment-form'].dispatch('submit');

  assert.equal(calls.payment, 0);
  assert.equal(calls.recurringStart, 1);
  const startRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/recurring/start'
  );
  assert.equal(startRequest.method, 'POST');
  assert.equal(startRequest.body.paymentType, 'recurring');
  assert.equal(startRequest.body.amount, '10.00');
  assert.equal(startRequest.body.transactionMode, 'submit_for_settlement');
  assert.equal(startRequest.body.expectedOutcome, 'approved');
  assert.equal(startRequest.body.recurringModel, 'merchant_managed');
  assert.equal(startRequest.body.planId, null);
  assert.equal(startRequest.body.nonce, 'three-d-secure-upgraded-reference');
  assert.equal(Object.hasOwn(startRequest.body, 'paymentMethodNonce'), false);
  assert.equal(Object.hasOwn(startRequest.body, 'merchantAccountId'), false);
  assert.equal(Object.hasOwn(startRequest.body, 'customerId'), false);
  assert.equal(elements['recurring-actions'].hidden, false);
  assert.equal(elements['run-next-cycle'].hidden, false);
  assert.equal(elements['run-vault-one-time'].hidden, false);
  assert.equal(elements['refresh-subscription'].hidden, true);
  assert.equal(elements['cancel-subscription'].hidden, true);
  assert.equal(elements['recurring-model-proof'].textContent, 'Model A · Merchant-managed');
  assert.equal(elements['transaction-source-proof'].textContent, 'recurring_first');
  assert.equal(
    elements['three-d-secure-scope-proof'].textContent,
    'Vault setup / recurring mandate'
  );

  await elements['run-next-cycle'].dispatch('click');
  assert.equal(calls.nextCycle, 1);
  assert.equal(elements['transaction-source-proof'].textContent, 'recurring');
  assert.equal(elements['inspector-state'].textContent, 'Next cycle verified');

  await elements['run-vault-one-time'].dispatch('click');
  assert.equal(calls.vaultOneTime, 1);
  assert.equal(elements['inspector-state'].textContent, 'Shared vault verified');

  const actionRequests = calls.requests.filter((request) =>
    request.url.startsWith('/api/demo/recurring/events/recurring-event-1/')
  );
  assert.deepEqual(
    actionRequests.map(({ url, method, body }) => ({ url, method, body })),
    [
      {
        url: '/api/demo/recurring/events/recurring-event-1/next-cycle',
        method: 'POST',
        body: null,
      },
      {
        url: '/api/demo/recurring/events/recurring-event-1/one-time',
        method: 'POST',
        body: null,
      },
    ]
  );
});

test('Model A presents required vault setup proof without claiming transaction authentication', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    threeDSecurePolicy: 'required',
  });
  await waitFor(() => calls.hostedFields === 1);

  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2 && !elements['run-payment'].disabled);
  await elements['demo-payment-form'].dispatch('submit');

  assert.equal(calls.recurringStart, 1);
  assert.equal(
    elements['three-d-secure-scope-proof'].textContent,
    'Vault setup / recurring mandate'
  );
  assert.equal(
    elements['verification-title'].textContent,
    'Route + vault setup verified'
  );
  assert.match(elements['verification-copy'].textContent, /recurring mandate/i);
  assert.match(elements['verification-copy'].textContent, /not this transaction/i);
  assert.doesNotMatch(
    elements['verification-title'].textContent,
    /card \+ 3D Secure verified/i
  );

  await elements['run-next-cycle'].dispatch('click');
  assert.equal(calls.nextCycle, 1);
  assert.equal(
    elements['verification-title'].textContent,
    'Route + vault setup verified'
  );
  assert.match(elements['verification-copy'].textContent, /not this transaction/i);
});

test('Model B submits the selected currency plan and exposes status and cancellation actions', async () => {
  const { calls, elements } = createClientHarness('route-mismatch');
  await waitFor(() => calls.hostedFields === 1);

  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  elements['recurring-model'].value = 'braintree_subscription';
  elements.amount.value = '77.00';
  await elements['recurring-model'].dispatch('change');
  await waitFor(() => calls.hostedFields === 3 && !elements['run-payment'].disabled);

  assert.equal(elements['plan-field'].hidden, false);
  assert.equal(elements['plan-id'].value, 'gbp-monthly');
  assert.equal(elements['plan-id'].disabled, false);
  assert.equal(elements.amount.value, '10.00');
  assert.equal(elements.amount.readOnly, true);
  assert.match(elements['plan-availability'].textContent, /1 plan available for GBP/);
  assert.equal(elements['merchant-managed-copy'].hidden, true);
  assert.equal(elements['braintree-subscription-copy'].hidden, false);
  assert.match(elements['run-payment-label'].textContent, /create subscription/i);

  await elements['demo-payment-form'].dispatch('submit');

  const startRequest = calls.requests.findLast(
    (request) => request.url === '/api/demo/recurring/start'
  );
  assert.equal(startRequest.body.recurringModel, 'braintree_subscription');
  assert.equal(startRequest.body.planId, 'gbp-monthly');
  assert.equal(startRequest.body.amount, '10.00');
  assert.equal(startRequest.body.nonce, 'three-d-secure-upgraded-reference');
  assert.equal(elements['run-next-cycle'].hidden, true);
  assert.equal(elements['run-vault-one-time'].hidden, false);
  assert.equal(elements['refresh-subscription'].hidden, false);
  assert.equal(elements['cancel-subscription'].hidden, false);
  assert.equal(
    elements['recurring-model-proof'].textContent,
    'Model B · Braintree Subscription'
  );
  assert.equal(
    elements['three-d-secure-scope-proof'].textContent,
    'Subscription transaction'
  );
  assert.equal(
    elements['verification-title'].textContent,
    'Route + payment method verified'
  );
  assert.match(
    elements['verification-copy'].textContent,
    /No transaction-level 3D Secure authentication was recorded/i
  );

  await elements['refresh-subscription'].dispatch('click');
  assert.equal(calls.subscriptionStatus, 1);
  assert.match(elements['recurring-action-status'].textContent, /Next billing date/);
  assert.equal(
    elements['three-d-secure-scope-proof'].textContent,
    'Subscription transaction'
  );
  assert.doesNotMatch(elements['verification-title'].textContent, /3D Secure verified/i);

  await elements['cancel-subscription'].dispatch('click');
  assert.equal(calls.subscriptionCancel, 1);
  assert.equal(calls.confirmations.length, 1);
  assert.match(calls.confirmations[0], /Future billing cycles will stop/);
  assert.equal(elements['cancel-subscription'].hidden, true);
  assert.equal(elements['inspector-state'].textContent, 'Subscription canceled');

  const statusRequest = calls.requests.findLast(
    (request) => request.url ===
      '/api/demo/recurring/subscriptions/subscription-event-1'
  );
  assert.deepEqual(
    { method: statusRequest.method, body: statusRequest.body },
    { method: 'GET', body: null }
  );
  const cancelRequest = calls.requests.findLast(
    (request) => request.url ===
      '/api/demo/recurring/subscriptions/subscription-event-1/cancel'
  );
  assert.deepEqual(
    { method: cancelRequest.method, body: cancelRequest.body },
    { method: 'POST', body: null }
  );
});

test('dismissing subscription cancellation leaves Braintree untouched', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    confirmCancellation: false,
  });
  await waitFor(() => calls.hostedFields === 1);

  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  elements['recurring-model'].value = 'braintree_subscription';
  await elements['recurring-model'].dispatch('change');
  await waitFor(() => calls.hostedFields === 3 && !elements['run-payment'].disabled);
  await elements['demo-payment-form'].dispatch('submit');

  await elements['cancel-subscription'].dispatch('click');

  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.subscriptionCancel, 0);
  assert.match(elements['recurring-action-status'].textContent, /not changed/i);
  assert.equal(elements['cancel-subscription'].hidden, false);
});

test('Model B fails closed with the exact no-plan state while Model A remains usable', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    planOptions: [],
  });
  await waitFor(() => calls.hostedFields === 1);

  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  elements['recurring-model'].value = 'braintree_subscription';
  await elements['recurring-model'].dispatch('change');
  await waitFor(() => calls.hostedFields === 3);

  assert.equal(elements['plan-id'].value, '');
  assert.equal(elements['plan-id'].options[0].textContent, 'No plan available');
  assert.equal(elements['plan-availability'].textContent, 'No plan available');
  assert.equal(elements['run-payment'].disabled, true);
  await elements['demo-payment-form'].dispatch('submit');
  assert.equal(calls.recurringStart, 0);
  assert.match(elements['checkout-status'].textContent, /No plan available for GBP/);

  elements['recurring-model'].value = 'merchant_managed';
  await elements['recurring-model'].dispatch('change');
  await waitFor(() => calls.hostedFields === 4 && !elements['run-payment'].disabled);
  assert.match(elements['run-payment-label'].textContent, /first billing cycle/i);
});

test('a terminal live subscription status hides cancellation and exposes its Sandbox record', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    subscriptionStatus: 'Expired',
  });
  await waitFor(() => calls.hostedFields === 1);

  elements['payment-type'].value = 'recurring';
  await elements['payment-type'].dispatch('change');
  await waitFor(() => calls.hostedFields === 2);
  elements['recurring-model'].value = 'braintree_subscription';
  await elements['recurring-model'].dispatch('change');
  await waitFor(() => calls.hostedFields === 3 && !elements['run-payment'].disabled);
  await elements['demo-payment-form'].dispatch('submit');

  assert.equal(elements['cancel-subscription'].hidden, false);
  await elements['refresh-subscription'].dispatch('click');

  assert.equal(calls.subscriptionStatus, 1);
  assert.equal(elements['cancel-subscription'].hidden, true);
  assert.equal(elements['control-panel-link'].hidden, false);
  assert.equal(
    elements['control-panel-link'].href,
    'https://sandbox.braintreegateway.com/merchants/test/subscriptions/subscription-1'
  );
});

test('an unavailable catalog at page load disables the runner without making an automatic API call', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    catalogAvailable: false,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.preview, 0);
  assert.equal(calls.token, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['payment-type'].disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /Gateway unavailable/i);
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
});

test('a CATALOG_UNAVAILABLE preview response fails closed before token setup', async () => {
  const { calls, elements } = createClientHarness('route-mismatch', {
    catalogUnavailableAt: 'preview',
  });

  await waitFor(() => elements['inspector-state'].textContent === 'Unavailable');

  assert.equal(calls.preview, 1);
  assert.equal(calls.token, 0);
  assert.equal(calls.hostedFields, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.match(elements['checkout-status'].textContent, /discovery is unavailable/i);
});

test('catalog refresh posts to the discovery endpoint and reloads after success', async () => {
  const { calls, refreshButton, refreshStatus } = createClientHarness(
    'route-mismatch',
    { catalogAvailable: false }
  );

  await refreshButton.dispatch('click');

  assert.equal(calls.refresh, 1);
  assert.equal(calls.reload, 1);
  assert.match(refreshStatus.textContent, /Reloading/i);
  assert.equal(refreshButton.disabled, false);
});

test('a failed catalog refresh immediately invalidates stale routing and catalog UI', async () => {
  const {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
  } = createClientHarness(
    'route-mismatch',
    { refreshOutcome: 'unavailable' }
  );
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);
  assert.match(elements['account-summary'].textContent, /paypal2/);

  await refreshButton.dispatch('click');

  assert.equal(calls.refresh, 1);
  assert.equal(calls.reload, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['payment-type'].disabled, true);
  assert.equal(elements.amount.disabled, true);
  assert.equal(elements['preview-route'].disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.equal(elements['account-summary'].textContent, 'No catalog');
  assert.equal(elements['intent-summary'].textContent, '—');
  assert.equal(elements['request-json'].textContent, '{}');
  assert.equal(elements['trace-count'].textContent, '0 checks');
  assert.equal(elements['result-json'].textContent, 'No transaction has been sent.');
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
  assert.ok(staleCatalogContent.every((element) => element.hidden));
  assert.match(elements['checkout-status'].textContent, /prior catalog was discarded/i);
  assert.match(refreshStatus.textContent, /prior catalog was discarded/i);
  assert.equal(refreshButton.disabled, false);
});

test('a refresh network failure also invalidates the current catalog presentation', async () => {
  const {
    calls,
    elements,
    refreshButton,
    refreshStatus,
    staleCatalogContent,
  } = createClientHarness(
    'route-mismatch',
    { refreshOutcome: 'network-error' }
  );
  await waitFor(() => calls.hostedFields === 1 && !elements['run-payment'].disabled);

  await refreshButton.dispatch('click');

  assert.equal(calls.reload, 0);
  assert.equal(elements.currency.disabled, true);
  assert.equal(elements['run-payment'].disabled, true);
  assert.equal(elements['account-summary'].textContent, 'No catalog');
  assert.equal(elements['inspector-state'].textContent, 'Unavailable');
  assert.ok(staleCatalogContent.every((element) => element.hidden));
  assert.match(elements['checkout-status'].textContent, /could not be completed/i);
  assert.match(refreshStatus.textContent, /could not be completed/i);
});

test('switching an approved Card intent to PayPal preserves the entered payment amount', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1 && !harness.elements['run-payment'].disabled);
  harness.elements.amount.value = '27.35';
  await harness.elements.amount.dispatch('input');
  await choosePayPal(harness);
  assert.equal(harness.elements.amount.value, '27.35');
  await harness.calls.paypalButtonConfig.createOrder();
  assert.equal(harness.calls.paypalCreates.at(-1).amount, '27.35');
  await harness.calls.paypalButtonConfig.onApprove({ orderID: 'sandbox-order-id' });
  const request = harness.calls.requests.findLast((item) => item.url === '/api/demo/payments/one-time');
  assert.equal(request.body.amount, '27.35');
  assert.equal(request.body.currency, 'GBP');
});

test('switching a failure demonstration to PayPal resets only the Sandbox trigger amount', async () => {
  const harness = createClientHarness('authorized');
  await waitFor(() => harness.calls.hostedFields === 1);
  harness.elements['expected-outcome'].value = 'processor_declined';
  await harness.elements['expected-outcome'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 2);
  assert.equal(harness.elements.amount.value, '2001.00');
  await choosePayPal(harness);
  assert.equal(harness.elements['expected-outcome'].value, 'approved');
  assert.equal(harness.elements.amount.value, '10.00');
});

test('Card and PayPal setup stop when authorization returns a changed or missing route', async (t) => {
  const changes = {
    account: (route) => ({ ...route, account: { ...route.account, merchantAccountId: 'changed-account' } }),
    policy: (route) => ({ ...route, account: { ...route.account, threeDSecurePolicy: 'required' } }),
    currency: (route) => ({ ...route, intent: { ...route.intent, currency: 'JPY' } }),
    missing: () => null,
  };
  for (const method of ['card', 'paypal']) {
    for (const [change, transform] of Object.entries(changes)) {
      await t.test(`${method}: ${change}`, async () => {
        let changed = true;
        const harness = createClientHarness('authorized', {
          tokenRoute: (route, body) => changed && body.paymentMethod === method ? transform(route) : route,
        });
        if (method === 'paypal') {
          await waitFor(() => harness.calls.hostedFields === 1);
          harness.elements['payment-method-card'].checked = false;
          harness.elements['payment-method-paypal'].checked = true;
          await harness.elements['payment-method-paypal'].dispatch('change');
        }
        await waitFor(() => harness.elements['inspector-state'].textContent === 'Route changed');
        assert.equal(harness.calls.clientCreates.length, method === 'card' ? 0 : 1);
        assert.equal(harness.calls.paypalCheckout, 0);
        assert.equal(harness.elements['run-payment'].disabled, true);
        await harness.elements['demo-payment-form'].dispatch('submit');
        assert.equal(harness.calls.payment, 0);
        assert.equal(harness.calls.recurringStart, 0);
        changed = false;
        await harness.elements['preview-route'].dispatch('click');
        await waitFor(() => method === 'card' ? harness.calls.hostedFields === 1 : harness.calls.paypalRenders === 1);
        assert.equal(harness.elements['run-payment'].disabled, false);
      });
    }
  }
});

test('required-policy Card subscriptions are blocked before authorization and recover with Model A or PayPal', async () => {
  const harness = createClientHarness('authorized', { threeDSecurePolicy: 'required' });
  await waitFor(() => harness.calls.hostedFields === 1);
  harness.elements['payment-type'].value = 'recurring';
  await harness.elements['payment-type'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 2);
  assert.equal(harness.elements['recurring-model'].options[1].disabled, true);
  assert.equal(harness.elements['recurring-availability'].hidden, false);
  const tokenCount = harness.calls.token;
  harness.elements['recurring-model'].value = 'braintree_subscription';
  await harness.elements['recurring-model'].dispatch('change');
  await waitFor(() => harness.elements['inspector-state'].textContent === 'Subscription unavailable');
  assert.equal(harness.calls.token, tokenCount);
  assert.equal(harness.elements['card-fields'].disabled, true);
  assert.equal(harness.elements['run-payment'].disabled, true);
  await harness.elements['demo-payment-form'].dispatch('submit');
  assert.equal(harness.calls.recurringStart, 0);
  assert.equal(harness.calls.threeDSecureVerifications.length, 0);
  assert.match(harness.elements['checkout-status'].textContent, /Model A/);

  harness.elements['recurring-model'].value = 'merchant_managed';
  await harness.elements['recurring-model'].dispatch('change');
  await waitFor(() => harness.calls.hostedFields === 3 && !harness.elements['run-payment'].disabled);
  await choosePayPal(harness);
  assert.equal(harness.elements['recurring-model'].options[1].disabled, false);
  assert.equal(harness.elements['recurring-availability'].hidden, true);
  harness.elements['recurring-model'].value = 'braintree_subscription';
  await harness.elements['recurring-model'].dispatch('change');
  await waitFor(() => harness.calls.paypalRenders === 2);
  await harness.calls.paypalButtonConfig.createBillingAgreement();
  await harness.calls.paypalButtonConfig.onApprove({ billingToken: 'sandbox-billing-token' });
  assert.equal(harness.calls.recurringStart, 1);
});
