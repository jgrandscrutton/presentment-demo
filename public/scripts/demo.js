'use strict';

(() => {
  const form = document.querySelector('#demo-payment-form');
  if (!form) {
    return;
  }

  const elements = {
    scenarioId: document.querySelector('#scenario-id'),
    paymentType: document.querySelector('#payment-type'),
    currency: document.querySelector('#currency'),
    transactionMode: document.querySelector('#transaction-mode'),
    expectedOutcome: document.querySelector('#expected-outcome'),
    recurringModel: document.querySelector('#recurring-model'),
    recurringOptions: document.querySelector('#recurring-options'),
    planField: document.querySelector('#plan-field'),
    planId: document.querySelector('#plan-id'),
    planAvailability: document.querySelector('#plan-availability'),
    merchantManagedCopy: document.querySelector('#merchant-managed-copy'),
    braintreeSubscriptionCopy: document.querySelector('#braintree-subscription-copy'),
    amount: document.querySelector('#amount'),
    currencyPrefix: document.querySelector('#currency-prefix'),
    demoRate: document.querySelector('#demo-rate'),
    sandboxOutcomeNotice: document.querySelector('#sandbox-outcome-notice'),
    advancedOptions: document.querySelector('.advanced-options'),
    runnerSteps: Array.from(document.querySelectorAll('[data-runner-step]')),
    presets: Array.from(document.querySelectorAll('.scenario-preset')),
    refreshButtons: Array.from(document.querySelectorAll('[data-catalog-refresh]')),
    refreshStatuses: Array.from(document.querySelectorAll('[data-refresh-status]')),
    staleCatalogContent: Array.from(
      document.querySelectorAll('[data-catalog-stale-content]')
    ),
    previewButton: document.querySelector('#preview-route'),
    runButton: document.querySelector('#run-payment'),
    runButtonLabel: document.querySelector('#run-payment-label'),
    payStepCopy: document.querySelector('#pay-step-copy'),
    paymentMethodChooser: document.querySelector('#payment-method-chooser'),
    paymentMethodCard: document.querySelector('#payment-method-card'),
    paymentMethodPayPal: document.querySelector('#payment-method-paypal'),
    paymentMethodCardOption: document.querySelector('#payment-method-card-option'),
    paymentMethodPayPalOption: document.querySelector('#payment-method-paypal-option'),
    paymentMethodAvailability: document.querySelector('#payment-method-availability'),
    cardFields: document.querySelector('#card-fields'),
    cardHint: document.querySelector('#sandbox-card-hint'),
    disputeCardHint: document.querySelector('#dispute-card-hint'),
    threeDSecurePanel: document.querySelector('#three-d-secure-panel'),
    threeDSecurePolicyBadge: document.querySelector('#three-d-secure-policy-badge'),
    threeDSecurePolicyCopy: document.querySelector('#three-d-secure-policy-copy'),
    threeDSecureOptionalControl: document.querySelector('#three-d-secure-optional-control'),
    threeDSecureEnabled: document.querySelector('#three-d-secure-enabled'),
    threeDSecureScenarios: document.querySelector('#three-d-secure-scenarios'),
    threeDSecureScenarioOptions: Array.from(
      document.querySelectorAll('input[name="threeDSecureScenario"]')
    ),
    threeDSecureCardCopy: document.querySelector('#three-d-secure-card-copy'),
    threeDSecureCardNumber: document.querySelector('#three-d-secure-card-number'),
    threeDSecureStatus: document.querySelector('#three-d-secure-status'),
    paypalFields: document.querySelector('#paypal-fields'),
    paypalButton: document.querySelector('#paypal-button'),
    paypalFlowCopy: document.querySelector('#paypal-flow-copy'),
    checkoutStatus: document.querySelector('#checkout-status'),
    recurringNotice: document.querySelector('#recurring-notice'),
    recurringNoticeCopy: document.querySelector('#recurring-notice-copy'),
    noRouteNotice: document.querySelector('#no-route-notice'),
    recurringActions: document.querySelector('#recurring-actions'),
    recurringActionStatus: document.querySelector('#recurring-action-status'),
    nextCycleButton: document.querySelector('#run-next-cycle'),
    vaultOneTimeButton: document.querySelector('#run-vault-one-time'),
    refreshSubscriptionButton: document.querySelector('#refresh-subscription'),
    cancelSubscriptionButton: document.querySelector('#cancel-subscription'),
    inspectorState: document.querySelector('#inspector-state'),
    intentSummary: document.querySelector('#intent-summary'),
    accountSummary: document.querySelector('#account-summary'),
    routeReason: document.querySelector('#route-reason'),
    traceCount: document.querySelector('#trace-count'),
    decisionTrace: document.querySelector('#decision-trace'),
    requestJson: document.querySelector('#request-json'),
    resultDetails: document.querySelector('#result-details'),
    resultJson: document.querySelector('#result-json'),
    verificationCard: document.querySelector('#verification-card'),
    verificationIcon: document.querySelector('#verification-icon'),
    verificationTitle: document.querySelector('#verification-title'),
    verificationCopy: document.querySelector('#verification-copy'),
    threeDSecureProof: document.querySelector('#three-d-secure-proof'),
    threeDSecurePolicyProof: document.querySelector('#three-d-secure-policy-proof'),
    threeDSecureScopeProof: document.querySelector('#three-d-secure-scope-proof'),
    threeDSecureStatusProof: document.querySelector('#three-d-secure-status-proof'),
    liabilityShiftPossibleProof: document.querySelector('#liability-shift-possible-proof'),
    liabilityShiftedProof: document.querySelector('#liability-shifted-proof'),
    recurringProof: document.querySelector('#recurring-proof'),
    recurringModelProof: document.querySelector('#recurring-model-proof'),
    transactionSourceProof: document.querySelector('#transaction-source-proof'),
    controlPanelLink: document.querySelector('#control-panel-link'),
    controlPanelLinkLabel: document.querySelector('#control-panel-link-label'),
  };

  const catalogAvailableAtLoad = document.body?.dataset.catalogAvailable === 'true';

  const paymentTypeLabels = {
    one_time: 'One-time',
    recurring: 'Recurring',
  };

  const transactionModeLabels = {
    submit_for_settlement: 'Sale',
    authorize_only: 'Authorize only',
  };

  const expectedOutcomeLabels = {
    approved: 'Approved',
    processor_declined: 'Processor decline',
    gateway_rejected: 'Gateway rejection',
  };

  const recurringModelLabels = {
    merchant_managed: 'Model A · Merchant-managed',
    braintree_subscription: 'Model B · Braintree Subscription',
  };

  const paymentMethodCardId = 'card';
  const paymentMethodPayPalId = 'paypal';

  const paymentMethodLabels = {
    [paymentMethodCardId]: 'Card',
    [paymentMethodPayPalId]: 'PayPal',
  };

  const threeDSecureScenarios = Object.freeze({
    frictionless: Object.freeze({
      cardNumber: '4000 0000 0000 2701',
      label: 'Frictionless authentication',
    }),
    challenge: Object.freeze({
      cardNumber: '4000 0000 0000 2503',
      label: 'Successful issuer challenge',
    }),
    failed: Object.freeze({
      cardNumber: '4000 0000 0000 2925',
      label: 'Failed authentication',
    }),
  });
  const standardSandboxCardNumber = '4111 1111 1111 1111';
  const disputeSandboxCardNumber = '4023 8984 9398 8028';

  let hostedFieldsInstance = null;
  let threeDSecureInstance = null;
  let paypalCheckoutInstance = null;
  let paypalButtonInstance = null;
  let paypalSdkConfigurationKey = null;
  const paypalSdkCache = new Map();
  let paymentSetupLifecycle = Promise.resolve();
  let paymentSetupReady = false;
  let paymentMethodRouteReady = false;
  let availablePaymentMethods = new Set(['card']);
  let previewGeneration = 0;
  let paymentRunning = false;
  let freshPreviewRequired = false;
  let catalogUnavailable = !catalogAvailableAtLoad;
  let currentRecurringEventId = null;
  let recurringActionRunning = false;
  let recurringStartCompleted = false;
  let disputeScenarioSelected = false;
  let completedPaymentMethod = null;
  let threeDSecurePolicy = null;

  function selectedPaymentMethod() {
    return elements.paymentMethodPayPal?.checked
      ? paymentMethodPayPalId
      : paymentMethodCardId;
  }

  function isPayPalSelected() {
    return selectedPaymentMethod() === paymentMethodPayPalId;
  }

  function normalizeThreeDSecurePolicy(value) {
    return value === 'required' || value === 'optional' ? value : null;
  }

  function selectedThreeDSecureScenario() {
    const selected = elements.threeDSecureScenarioOptions.find(
      (option) => option.checked
    );
    return selected?.value && threeDSecureScenarios[selected.value]
      ? selected.value
      : 'frictionless';
  }

  function setThreeDSecureStatus(message, state = 'ready') {
    if (!elements.threeDSecureStatus) return;
    elements.threeDSecureStatus.textContent = message;
    elements.threeDSecureStatus.dataset.state = state;
    if (elements.threeDSecurePanel) {
      if (state === 'authenticating') {
        elements.threeDSecurePanel.setAttribute('aria-busy', 'true');
      } else {
        elements.threeDSecurePanel.removeAttribute('aria-busy');
      }
    }
  }

  function useThreeDSecureForCard() {
    if (
      isPayPalSelected() ||
      !threeDSecurePolicy ||
      disputeScenarioSelected
    ) {
      return false;
    }
    return threeDSecurePolicy === 'required' ||
      elements.threeDSecureEnabled?.checked === true;
  }

  function refreshThreeDSecureScenarioHint() {
    const scenario = threeDSecureScenarios[selectedThreeDSecureScenario()];
    if (elements.threeDSecureCardNumber) {
      elements.threeDSecureCardNumber.textContent = scenario.cardNumber;
    }
    if (typeof hostedFieldsInstance?.setAttribute === 'function') {
      const placeholder = disputeScenarioSelected
        ? disputeSandboxCardNumber
        : useThreeDSecureForCard()
          ? scenario.cardNumber
          : standardSandboxCardNumber;
      try {
        hostedFieldsInstance.setAttribute(
          {
            field: 'number',
            attribute: 'placeholder',
            value: placeholder,
          },
          () => undefined
        );
      } catch {
        // The visible Sandbox guidance remains available if the iframe cannot update.
      }
    }
  }

  function updateThreeDSecurePresentation() {
    if (!elements.threeDSecurePanel) return;
    const visible = Boolean(
      paymentMethodRouteReady &&
      !isPayPalSelected() &&
      threeDSecurePolicy &&
      !disputeScenarioSelected
    );
    elements.threeDSecurePanel.hidden = !visible;
    if (!visible) return;

    const required = threeDSecurePolicy === 'required';
    if (elements.threeDSecurePolicyBadge) {
      elements.threeDSecurePolicyBadge.textContent = required
        ? 'Required by route'
        : 'Optional on route';
      elements.threeDSecurePolicyBadge.className =
        `three-d-secure-policy-badge ${required ? 'is-required' : 'is-optional'}`;
    }
    if (elements.threeDSecurePolicyCopy) {
      elements.threeDSecurePolicyCopy.textContent = required
        ? 'The server will reject this card before sale unless Braintree proves authentication and liability shift.'
        : 'Authentication is available for comparison, but this route also accepts a plain card nonce.';
    }
    if (elements.threeDSecureOptionalControl) {
      elements.threeDSecureOptionalControl.hidden = required;
    }
    if (elements.threeDSecureEnabled) {
      if (required) elements.threeDSecureEnabled.checked = true;
      elements.threeDSecureEnabled.disabled =
        required || paymentRunning || !threeDSecureInstance;
    }
    if (elements.threeDSecureScenarios) {
      elements.threeDSecureScenarios.disabled =
        paymentRunning || !useThreeDSecureForCard() || !threeDSecureInstance;
    }
    if (elements.threeDSecureCardCopy) {
      elements.threeDSecureCardCopy.hidden = !useThreeDSecureForCard();
    }
    refreshThreeDSecureScenarioHint();
  }

  function currentIntent() {
    return {
      scenarioId: elements.scenarioId.value,
      currency: elements.currency.value,
      paymentType: elements.paymentType.value,
      amount: elements.amount.value,
      transactionMode: elements.transactionMode.value,
      expectedOutcome: elements.expectedOutcome.value,
      paymentMethod: selectedPaymentMethod(),
    };
  }

  function isRecurringIntent() {
    return elements.paymentType.value === 'recurring';
  }

  function isSubscriptionModel() {
    return isRecurringIntent() &&
      elements.recurringModel?.value === 'braintree_subscription';
  }

  function selectedPlanAvailable() {
    return !isSubscriptionModel() || Boolean(elements.planId?.value);
  }

  function recurringStartRequest(nonce, intent = currentIntent()) {
    return {
      ...intent,
      recurringModel: elements.recurringModel?.value || 'merchant_managed',
      planId: isSubscriptionModel() ? elements.planId?.value || null : null,
      nonce,
    };
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);

    let data;
    let readable = true;
    try {
      data = await response.json();
    } catch {
      readable = false;
      data = {
        success: false,
        error: { message: 'The server returned an unreadable response.' },
      };
    }

    return { ok: response.ok, status: response.status, data, readable };
  }

  function postJson(url, body) {
    return requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function formatJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function setInspectorState(label, state) {
    elements.inspectorState.textContent = label;
    elements.inspectorState.className = `inspector-state is-${state}`;
  }

  function setCheckoutStatus(message, state = 'neutral') {
    elements.checkoutStatus.textContent = message;
    elements.checkoutStatus.dataset.state = state;
  }

  function setRunnerProgress(currentStep) {
    const order = ['choose', 'preview', 'pay', 'verify'];
    const currentIndex = order.indexOf(currentStep);
    if (currentIndex === -1) return;

    for (const step of elements.runnerSteps) {
      const stepIndex = order.indexOf(step.dataset.runnerStep);
      const current = stepIndex === currentIndex;
      step.classList.toggle('is-current', current);
      step.classList.toggle('is-complete', stepIndex >= 0 && stepIndex < currentIndex);
      if (current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
  }

  function updatePresetAvailability(disabled = catalogUnavailable || paymentRunning) {
    for (const preset of elements.presets) {
      const switchesToCard = isPayPalSelected();
      const usesCardTrigger =
        (preset.dataset.expectedOutcome || 'approved') !== 'approved' ||
        preset.dataset.disputeScenario === 'true';
      preset.disabled = disabled;
      preset.classList.remove('is-method-unavailable');
      if (switchesToCard) {
        const label = preset.textContent.replace(/\s+/g, ' ').trim();
        preset.setAttribute(
          'aria-label',
          usesCardTrigger
            ? `${label}. Selecting this scenario switches the payment method to Card because it uses a Sandbox card trigger.`
            : `${label}. Selecting this preset switches the payment method to Card while its route is rechecked.`
        );
      } else {
        preset.removeAttribute('aria-label');
      }
    }
  }

  function refreshPaymentMethodPresentation() {
    const paypalSelected = isPayPalSelected();
    const cardReady = paymentSetupReady && !paypalSelected;
    const paymentActionAvailable =
      paymentSetupReady &&
      !paymentRunning &&
      !freshPreviewRequired &&
      !(isRecurringIntent() && recurringStartCompleted) &&
      selectedPlanAvailable();

    if (elements.paymentMethodCardOption) {
      elements.paymentMethodCardOption.hidden = !availablePaymentMethods.has('card');
      elements.paymentMethodCardOption.classList.toggle('is-selected', !paypalSelected);
    }
    if (elements.paymentMethodPayPalOption) {
      elements.paymentMethodPayPalOption.hidden =
        !availablePaymentMethods.has(paymentMethodPayPalId);
      elements.paymentMethodPayPalOption.classList.toggle('is-selected', paypalSelected);
    }
    if (elements.paymentMethodChooser) {
      elements.paymentMethodChooser.disabled =
        catalogUnavailable || paymentRunning || !paymentMethodRouteReady;
    }
    if (elements.paymentMethodCard) {
      elements.paymentMethodCard.disabled =
        !paymentMethodRouteReady || !availablePaymentMethods.has('card');
    }
    if (elements.paymentMethodPayPal) {
      elements.paymentMethodPayPal.disabled =
        !paymentMethodRouteReady ||
        !availablePaymentMethods.has(paymentMethodPayPalId);
    }

    elements.cardFields.hidden = paypalSelected;
    elements.cardFields.disabled = !cardReady;
    elements.cardFields.classList.toggle('is-disabled', !cardReady);
    if (elements.paypalFields) {
      elements.paypalFields.hidden = !paypalSelected;
      elements.paypalFields.classList.toggle(
        'is-disabled',
        paypalSelected && !paymentActionAvailable
      );
    }
    if (elements.paypalButton) {
      elements.paypalButton.setAttribute(
        'aria-disabled',
        String(!paymentActionAvailable)
      );
    }
    elements.cardHint.hidden =
      !cardReady || disputeScenarioSelected || useThreeDSecureForCard();
    if (elements.disputeCardHint) {
      elements.disputeCardHint.hidden = !cardReady || !disputeScenarioSelected;
    }
    if (elements.payStepCopy) {
      elements.payStepCopy.textContent = paypalSelected
        ? 'Approve in PayPal Sandbox'
        : useThreeDSecureForCard()
          ? isRecurringIntent()
            ? 'Authenticate card, then vault'
            : 'Authenticate card, then pay'
          : 'Enter a Sandbox card';
    }
    if (elements.recurringNoticeCopy) {
      elements.recurringNoticeCopy.textContent = paypalSelected
        ? 'The PayPal account will be approved and vaulted on the server-resolved recurring merchant account. Approved sale mode is required for this flow.'
        : 'The card will be verified and vaulted on the server-resolved recurring merchant account. Approved sale mode is required for this flow.';
    }
    elements.runButton.hidden = paypalSelected;
    elements.runButton.disabled =
      !paymentActionAvailable;
    updateThreeDSecurePresentation();
    updatePresetAvailability();
  }

  function setPaymentSetupAvailability(available) {
    paymentSetupReady = available;
    refreshPaymentMethodPresentation();
  }

  function setIntentControlsDisabled(disabled) {
    elements.paymentType.disabled = disabled;
    elements.currency.disabled = disabled;
    elements.transactionMode.disabled = disabled || isRecurringIntent();
    elements.expectedOutcome.disabled =
      disabled || isRecurringIntent() || isPayPalSelected();
    if (elements.recurringModel) elements.recurringModel.disabled = disabled;
    if (elements.planId) {
      elements.planId.disabled =
        disabled || !isSubscriptionModel() || !hasPlansForSelectedCurrency();
    }
    elements.amount.disabled = disabled;
    elements.previewButton.disabled = disabled;
    if (elements.paymentMethodChooser) {
      elements.paymentMethodChooser.disabled = disabled || !paymentMethodRouteReady;
    }
    updatePresetAvailability(disabled);
  }

  function selectedCurrencyOption() {
    return Array.from(elements.currency.options || []).find(
      (option) => option.value === elements.currency.value
    );
  }

  function planOptions() {
    return Array.from(elements.planId?.options || []).filter(
      (option) => typeof option.dataset?.currency === 'string'
    );
  }

  function plansForSelectedCurrency() {
    return planOptions().filter(
      (option) => option.dataset.currency === elements.currency.value
    );
  }

  function selectedPlanOption() {
    return plansForSelectedCurrency().find(
      (option) => option.value === elements.planId?.value
    ) || null;
  }

  function hasPlansForSelectedCurrency() {
    return plansForSelectedCurrency().length > 0;
  }

  function updatePlanAvailability() {
    if (!elements.planId) return;

    const matching = plansForSelectedCurrency();
    const placeholder = Array.from(elements.planId.options || []).find(
      (option) => !option.dataset?.currency
    );
    const matchingValues = new Set(matching.map((option) => option.value));
    for (const option of planOptions()) {
      const visible = matchingValues.has(option.value);
      option.hidden = !visible;
      option.disabled = !visible;
    }

    if (!matchingValues.has(elements.planId.value)) {
      elements.planId.value = matching[0]?.value || '';
    }
    if (placeholder) {
      placeholder.textContent = matching.length > 0
        ? 'Select a discovered plan'
        : 'No plan available';
    }

    if (elements.planAvailability) {
      elements.planAvailability.textContent = matching.length > 0
        ? `${matching.length} ${matching.length === 1 ? 'plan' : 'plans'} available for ${elements.currency.value}`
        : 'No plan available';
      elements.planAvailability.dataset.state = matching.length > 0
        ? 'available'
        : 'unavailable';
    }

    elements.planId.disabled =
      catalogUnavailable ||
      paymentRunning ||
      !isSubscriptionModel() ||
      matching.length === 0;
  }

  function syncSubscriptionPlanPrice() {
    if (!isSubscriptionModel()) return;

    const option = selectedPlanOption();
    const price = typeof option?.dataset?.price === 'string'
      ? option.dataset.price.trim()
      : '';
    elements.amount.readOnly = true;
    if (price) {
      elements.amount.value = price;
      elements.amount.removeAttribute('min');
      elements.amount.removeAttribute('max');
      if (elements.demoRate) {
        elements.demoRate.textContent =
          `${elements.currency.value} price owned by the discovered Braintree plan`;
      }
    }
  }

  function updateRecurringConfiguration({ announce = false } = {}) {
    const recurring = isRecurringIntent();
    const subscription = isSubscriptionModel();

    if (recurring) {
      elements.transactionMode.value = 'submit_for_settlement';
      elements.expectedOutcome.value = 'approved';
      elements.amount.readOnly = false;
      elements.transactionMode.disabled = true;
      elements.expectedOutcome.disabled = true;
    } else {
      elements.transactionMode.disabled = catalogUnavailable || paymentRunning;
      elements.expectedOutcome.disabled =
        catalogUnavailable || paymentRunning || isPayPalSelected();
    }

    if (elements.recurringOptions) elements.recurringOptions.hidden = !recurring;
    if (elements.recurringNotice) elements.recurringNotice.hidden = !recurring;
    if (elements.planField) elements.planField.hidden = !subscription;
    if (elements.merchantManagedCopy) {
      elements.merchantManagedCopy.hidden = subscription;
    }
    if (elements.braintreeSubscriptionCopy) {
      elements.braintreeSubscriptionCopy.hidden = !subscription;
    }

    updatePlanAvailability();
    updateExpectedOutcomeConfiguration({ resetAmount: false });
    syncSubscriptionPlanPrice();
    updateRunButtonLabel();
    refreshPaymentMethodPresentation();

    if (announce && recurring && subscription && !hasPlansForSelectedCurrency()) {
      setCheckoutStatus(
        `No plan available for ${elements.currency.value}. Model A remains available.`,
        'preview'
      );
    }
  }

  function updateCurrencyConfiguration({ resetAmount = false } = {}) {
    const option = selectedCurrencyOption();
    if (!option) {
      elements.currencyPrefix.textContent = elements.currency.value || '—';
      return;
    }

    elements.currencyPrefix.textContent = option.dataset.symbol || option.value;
    elements.amount.step = option.dataset.step || '0.01';
    elements.amount.setAttribute(
      'inputmode',
      elements.amount.step === '1' ? 'numeric' : 'decimal'
    );
    updateExpectedOutcomeConfiguration({ resetAmount });
  }

  function updateExpectedOutcomeConfiguration({ resetAmount = true } = {}) {
    const option = selectedCurrencyOption();
    const expectedOutcome = isRecurringIntent() || isPayPalSelected()
      ? 'approved'
      : elements.expectedOutcome.value;
    if (isRecurringIntent() || isPayPalSelected()) {
      elements.expectedOutcome.value = 'approved';
    }
    const approved = expectedOutcome === 'approved';
    const sandboxAmount = expectedOutcome === 'processor_declined'
      ? option?.dataset.processorDeclinedAmount
      : expectedOutcome === 'gateway_rejected'
        ? option?.dataset.gatewayRejectedAmount
        : null;

    elements.amount.readOnly = !approved;
    if (approved) {
      elements.amount.min = option?.dataset.minimum || '0.01';
      elements.amount.max = option?.dataset.maximum || '1999.99';
      if (resetAmount && option?.dataset.demoAmount) {
        elements.amount.value = option.dataset.demoAmount;
      }
      if (elements.demoRate) {
        elements.demoRate.textContent = option?.dataset.demoRate || 'Demo rate unavailable';
      }
      elements.sandboxOutcomeNotice.hidden = true;
    } else {
      elements.amount.min = sandboxAmount || '0';
      elements.amount.max = sandboxAmount || '0';
      if (sandboxAmount) elements.amount.value = sandboxAmount;
      if (elements.demoRate) {
        elements.demoRate.textContent = `${expectedOutcomeLabels[expectedOutcome]} Sandbox trigger · not demo FX`;
      }
      elements.sandboxOutcomeNotice.hidden = false;
    }

    updateRunButtonLabel();
  }

  function updateRunButtonLabel() {
    if (!elements.runButtonLabel) return;
    const expectedOutcome = elements.expectedOutcome.value;
    const methodLabel = paymentMethodLabels[selectedPaymentMethod()] || 'Payment method';
    const authenticatingCard =
      selectedPaymentMethod() === paymentMethodCardId && useThreeDSecureForCard();

    if (isRecurringIntent() && isSubscriptionModel()) {
      elements.runButtonLabel.textContent = authenticatingCard
        ? 'Authenticate + vault card + create subscription'
        : `Vault ${methodLabel.toLowerCase()} + create subscription`;
    } else if (isRecurringIntent()) {
      elements.runButtonLabel.textContent = authenticatingCard
        ? 'Authenticate + vault card + run first billing cycle'
        : `Vault ${methodLabel.toLowerCase()} + run first billing cycle`;
    } else if (expectedOutcome === 'processor_declined') {
      elements.runButtonLabel.textContent = 'Run expected processor decline';
    } else if (expectedOutcome === 'gateway_rejected') {
      elements.runButtonLabel.textContent = 'Run expected gateway rejection';
    } else if (elements.transactionMode.value === 'authorize_only') {
      elements.runButtonLabel.textContent = authenticatingCard
        ? 'Authenticate + authorize sandbox payment'
        : 'Authorize sandbox payment';
    } else {
      elements.runButtonLabel.textContent = authenticatingCard
        ? 'Authenticate + run sandbox payment'
        : 'Run sandbox payment';
    }
  }

  function isCatalogUnavailable(payload) {
    return payload?.error?.code === 'CATALOG_UNAVAILABLE';
  }

  function renderCatalogUnavailable(payload) {
    const message =
      payload?.error?.message ||
      'Merchant account discovery is unavailable. Refresh the gateway catalog before routing.';

    previewGeneration += 1;
    catalogUnavailable = true;
    freshPreviewRequired = false;
    if (document.body?.dataset) {
      document.body.dataset.catalogAvailable = 'false';
    }
    for (const staleElement of elements.staleCatalogContent) {
      staleElement.hidden = true;
    }
    paymentMethodRouteReady = false;
    threeDSecurePolicy = null;
    availablePaymentMethods = new Set(['card']);
    setPaymentSetupAvailability(false);
    setIntentControlsDisabled(true);
    elements.intentSummary.textContent = '—';
    elements.accountSummary.textContent = 'No catalog';
    elements.routeReason.textContent = message;
    elements.requestJson.textContent = '{}';
    renderTrace([]);
    resetTransactionProof();
    elements.noRouteNotice.hidden = true;
    if (elements.recurringNotice) elements.recurringNotice.hidden = true;
    if (elements.recurringOptions) elements.recurringOptions.hidden = true;
    setInspectorState('Unavailable', 'blocked');
    setCheckoutStatus(message, 'blocked');
    setRunnerProgress('choose');
  }

  function setRefreshStatus(message) {
    for (const [index, status] of elements.refreshStatuses.entries()) {
      if (index === 0) {
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
      } else {
        status.removeAttribute('role');
        status.removeAttribute('aria-live');
      }
      status.textContent = message;
    }
  }

  async function refreshCatalog() {
    for (const button of elements.refreshButtons) {
      button.disabled = true;
    }
    setRefreshStatus('Discovering merchant accounts…');

    try {
      const response = await postJson('/api/demo/catalog/refresh', {});
      const refreshed =
        response.ok &&
        response.data?.success !== false &&
        response.data?.status !== 'failed' &&
        response.data?.catalog?.status !== 'failed';

      if (!refreshed) {
        const message =
          response.data?.error?.message ||
          'Merchant account discovery did not complete. Check the server and try again.';
        renderCatalogUnavailable({
          ...response.data,
          error: {
            ...response.data?.error,
            code: 'CATALOG_UNAVAILABLE',
            message,
          },
        });
        await schedulePaymentMethodTeardown();
        setRefreshStatus(message);
        return;
      }

      setRefreshStatus('Catalog refreshed. Reloading the demo…');
      window.location.reload();
    } catch {
      const message = 'The catalog refresh request could not be completed.';
      renderCatalogUnavailable({
        error: { code: 'CATALOG_UNAVAILABLE', message },
      });
      await schedulePaymentMethodTeardown();
      setRefreshStatus(message);
    } finally {
      for (const button of elements.refreshButtons) {
        button.disabled = false;
      }
    }
  }

  async function teardownHostedFields() {
    const instance = hostedFieldsInstance;
    hostedFieldsInstance = null;

    if (instance && typeof instance.teardown === 'function') {
      try {
        await instance.teardown();
      } catch {
        // The containers are rebuilt by the next Hosted Fields initialization.
      }
    }
  }

  async function teardownThreeDSecure() {
    const instance = threeDSecureInstance;
    threeDSecureInstance = null;

    if (instance && typeof instance.teardown === 'function') {
      try {
        await instance.teardown();
      } catch {
        // A fresh route preview creates a new 3D Secure component.
      }
    }
  }

  async function teardownPayPal() {
    const button = paypalButtonInstance;
    const instance = paypalCheckoutInstance;
    paypalButtonInstance = null;
    paypalCheckoutInstance = null;
    paypalSdkConfigurationKey = null;

    if (button && typeof button.close === 'function') {
      try {
        await button.close();
      } catch {
        // The PayPal iframe may already have closed itself.
      }
    }
    if (elements.paypalButton) elements.paypalButton.replaceChildren();

    if (instance && typeof instance.teardown === 'function') {
      try {
        await instance.teardown();
      } catch {
        // A fresh route preview creates a new Braintree PayPal component.
      }
    }
  }

  async function teardownPaymentMethods() {
    setPaymentSetupAvailability(false);
    await teardownHostedFields();
    await teardownThreeDSecure();
    await teardownPayPal();
  }

  function schedulePaymentMethodPreparation(routePayload, generation) {
    paymentSetupLifecycle = paymentSetupLifecycle
      .catch(() => undefined)
      .then(() => preparePaymentMethod(routePayload, generation));
    return paymentSetupLifecycle;
  }

  function schedulePaymentMethodTeardown() {
    paymentSetupLifecycle = paymentSetupLifecycle
      .catch(() => undefined)
      .then(() => teardownPaymentMethods());
    return paymentSetupLifecycle;
  }

  function resetTransactionProof() {
    elements.verificationCard.hidden = true;
    elements.verificationCard.classList.remove('is-failed');
    elements.resultJson.textContent = 'No transaction has been sent.';
    elements.resultDetails.open = false;
    elements.controlPanelLink.hidden = true;
    elements.controlPanelLink.removeAttribute('href');
    resetThreeDSecureProof();
    resetRecurringProof();
  }

  function resetThreeDSecureProof() {
    if (elements.threeDSecureProof) elements.threeDSecureProof.hidden = true;
    if (elements.threeDSecurePolicyProof) {
      elements.threeDSecurePolicyProof.textContent = '—';
    }
    if (elements.threeDSecureScopeProof) {
      elements.threeDSecureScopeProof.textContent = 'Current payment attempt';
    }
    if (elements.threeDSecureStatusProof) {
      elements.threeDSecureStatusProof.textContent = 'Not performed';
      delete elements.threeDSecureStatusProof.dataset.state;
    }
    for (const field of [
      elements.liabilityShiftPossibleProof,
      elements.liabilityShiftedProof,
    ]) {
      if (!field) continue;
      field.textContent = '—';
      delete field.dataset.state;
    }
  }

  function readableThreeDSecureStatus(status) {
    if (typeof status !== 'string' || status.trim() === '') return null;
    const normalized = status.trim().toLowerCase();
    const labels = {
      authenticate_successful: 'Authenticated',
      authenticate_attempt_successful: 'Authentication attempted',
      authenticate_rejected: 'Authentication rejected',
      authenticate_error: 'Authentication error',
      authentication_unavailable: 'Authentication unavailable',
      lookup_enrolled: 'Challenge required',
      lookup_not_enrolled: 'Card not enrolled',
      lookup_bypassed: 'Lookup bypassed',
      lookup_error: 'Lookup error',
    };
    if (labels[normalized]) return labels[normalized];
    return normalized
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function renderLiabilityValue(element, value, { notApplicable = false } = {}) {
    if (!element) return;
    element.textContent = notApplicable
      ? 'Not applicable'
      : value === true
        ? 'Yes'
        : value === false
          ? 'No'
          : '—';
    if (notApplicable || typeof value !== 'boolean') {
      delete element.dataset.state;
    } else {
      element.dataset.state = value ? 'passed' : 'failed';
    }
  }

  function renderThreeDSecureProof(payloadOrVerification) {
    if (!elements.threeDSecureProof) return;
    const payload = payloadOrVerification || {};
    const verification = payload.threeDSecureVerification || payload;
    const policy = normalizeThreeDSecurePolicy(
      verification.policy ||
      payload.route?.account?.threeDSecurePolicy ||
      threeDSecurePolicy
    );
    const paymentMethod =
      payload.request?.paymentMethod ||
      payload.paymentMethod ||
      selectedPaymentMethod();
    const applicable = verification.applicable === false
      ? false
      : paymentMethod === paymentMethodCardId;
    if (!policy && applicable) {
      elements.threeDSecureProof.hidden = true;
      return;
    }

    elements.threeDSecureProof.hidden = false;
    elements.threeDSecurePolicyProof.textContent = applicable
      ? policy === 'required' ? 'Required' : 'Optional'
      : 'Not applicable · PayPal';
    if (elements.threeDSecureScopeProof) {
      const scopeLabels = {
        vault_setup: 'Vault setup / recurring mandate',
        subscription_transaction: 'Subscription transaction',
        vaulted_one_time_transaction: 'Vaulted one-time transaction',
      };
      elements.threeDSecureScopeProof.textContent = applicable
        ? scopeLabels[verification.evidenceScope] || 'Current payment attempt'
        : 'Not applicable';
    }
    const readableStatus = readableThreeDSecureStatus(verification.status);
    elements.threeDSecureStatusProof.textContent = applicable
      ? readableStatus || (verification.performed ? 'Performed' : 'Not performed')
      : 'Not applicable';
    if (verification.passed === false) {
      elements.threeDSecureStatusProof.dataset.state = 'failed';
    } else if (verification.performed) {
      elements.threeDSecureStatusProof.dataset.state = 'passed';
    } else {
      delete elements.threeDSecureStatusProof.dataset.state;
    }
    renderLiabilityValue(
      elements.liabilityShiftPossibleProof,
      verification.liabilityShiftPossible,
      { notApplicable: !applicable }
    );
    renderLiabilityValue(
      elements.liabilityShiftedProof,
      verification.liabilityShifted,
      { notApplicable: !applicable }
    );
  }

  function resetRecurringProof() {
    currentRecurringEventId = null;
    recurringStartCompleted = false;
    completedPaymentMethod = null;
    if (elements.recurringActions) elements.recurringActions.hidden = true;
    if (elements.recurringActionStatus) elements.recurringActionStatus.textContent = '';
    if (elements.recurringProof) elements.recurringProof.hidden = true;
    if (elements.recurringModelProof) elements.recurringModelProof.textContent = '—';
    if (elements.transactionSourceProof) {
      elements.transactionSourceProof.textContent = '—';
    }
    setRecurringActionButtonsDisabled(false);
  }

  function recurringActionButtons() {
    return [
      elements.nextCycleButton,
      elements.vaultOneTimeButton,
      elements.refreshSubscriptionButton,
      elements.cancelSubscriptionButton,
    ].filter(Boolean);
  }

  function setRecurringActionButtonsDisabled(disabled) {
    for (const button of recurringActionButtons()) {
      button.disabled = disabled;
    }
  }

  function renderResolvingState() {
    const intent = currentIntent();
    threeDSecurePolicy = null;
    paymentMethodRouteReady = false;
    updateThreeDSecurePresentation();
    const mode = transactionModeLabels[intent.transactionMode] || intent.transactionMode;
    const method = paymentMethodLabels[intent.paymentMethod] || intent.paymentMethod;
    elements.intentSummary.textContent = `${intent.currency} · ${paymentTypeLabels[intent.paymentType] || intent.paymentType} · ${method} · ${mode}`;
    elements.accountSummary.textContent = 'Resolving…';
    elements.routeReason.textContent = 'The server is evaluating every configured merchant account.';
    elements.requestJson.textContent = '{}';
    if (elements.recurringNotice) elements.recurringNotice.hidden = true;
    elements.noRouteNotice.hidden = true;
    renderTrace([]);
  }

  function renderTrace(trace) {
    elements.decisionTrace.replaceChildren();
    const entries = Array.isArray(trace) ? trace : [];
    elements.traceCount.textContent = `${entries.length} ${entries.length === 1 ? 'check' : 'checks'}`;

    for (const entry of entries) {
      const item = document.createElement('li');
      item.className = entry.result === 'matched' ? 'trace-match' : 'trace-skip';

      const marker = document.createElement('span');
      marker.className = 'trace-marker';
      marker.textContent = entry.result === 'matched' ? '✓' : '–';
      marker.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('div');
      const account = document.createElement('strong');
      account.textContent = entry.account;
      const explanation = document.createElement('span');
      const policy = normalizeThreeDSecurePolicy(entry.threeDSecurePolicy);
      explanation.textContent = policy && entry.result === 'matched'
        ? `${entry.why} Card 3D Secure: ${policy === 'required' ? 'Required' : 'Optional'}.`
        : entry.why;
      copy.append(account, explanation);

      item.append(marker, copy);
      elements.decisionTrace.append(item);
    }
  }

  function renderDecision(payload) {
    const route = payload.route;
    const request = payload.request || {};
    const paymentType = paymentTypeLabels[route.intent.paymentType] || route.intent.paymentType;
    const transactionMode =
      transactionModeLabels[request.transactionMode] || request.transactionMode;
    const method =
      paymentMethodLabels[request.paymentMethod] || request.paymentMethod;

    elements.intentSummary.textContent = [
      route.intent.currency || '—',
      paymentType || '—',
      method,
      transactionMode,
    ].filter(Boolean).join(' · ');
    elements.accountSummary.textContent = route.matched
      ? `${route.account.label} · ${route.account.merchantAccountId}`
      : 'No route';
    elements.routeReason.textContent = route.reason;
    elements.requestJson.textContent = formatJson(request);
    renderTrace(route.trace);
    threeDSecurePolicy = route.matched
      ? normalizeThreeDSecurePolicy(route.account?.threeDSecurePolicy)
      : null;
    updateRunButtonLabel();

    const recurring = route.intent.paymentType === 'recurring';
    if (elements.recurringNotice) elements.recurringNotice.hidden = !recurring;
    elements.noRouteNotice.hidden = route.matched;

    if (!route.matched) {
      paymentMethodRouteReady = false;
      availablePaymentMethods = new Set(['card']);
      refreshPaymentMethodPresentation();
      setInspectorState('No route', 'blocked');
      setCheckoutStatus('No gateway call will be made for this intent.', 'blocked');
    } else {
      const configuredMethods = Array.isArray(route.account?.paymentMethods)
        ? route.account.paymentMethods.filter((paymentMethod) =>
            [paymentMethodCardId, paymentMethodPayPalId].includes(paymentMethod)
          )
        : ['card'];
      availablePaymentMethods = new Set(
        configuredMethods.includes('card') ? configuredMethods : ['card']
      );
      if (!availablePaymentMethods.has(selectedPaymentMethod())) {
        elements.paymentMethodCard.checked = true;
        if (elements.paymentMethodPayPal) elements.paymentMethodPayPal.checked = false;
      }
      paymentMethodRouteReady = true;
      if (elements.paymentMethodAvailability) {
        elements.paymentMethodAvailability.textContent =
          availablePaymentMethods.has(paymentMethodPayPalId)
            ? 'Card and PayPal are enabled for this server-selected account.'
            : 'Card is the only enabled method for this server-selected account.';
      }
      refreshPaymentMethodPresentation();
      setInspectorState('Route ready', 'ready');
      setCheckoutStatus(
        isPayPalSelected()
          ? recurring
            ? 'Recurring route resolved. Loading Braintree-mediated PayPal vaulting…'
            : 'Route resolved. Loading Braintree-mediated PayPal…'
          : recurring
            ? 'Recurring route resolved. Loading secure card fields for vaulting…'
            : 'Route resolved. Loading secure card fields…'
      );
    }

    renderThreeDSecureProof({
      route,
      request,
      threeDSecureVerification: {
        policy: threeDSecurePolicy,
        applicable: request.paymentMethod !== paymentMethodPayPalId,
        required: threeDSecurePolicy === 'required',
        performed: false,
        status: null,
        liabilityShiftPossible: null,
        liabilityShifted: null,
      },
    });
  }

  function renderVerification(payload) {
    if (!payload?.verification) return;

    const checks = [
      payload.verification,
      payload.currencyVerification,
      payload.paymentMethodVerification,
      payload.threeDSecureVerification,
    ].filter(Boolean);
    const passed = checks.every((check) => check.passed === true);
    const verifiedMethod =
      payload.paymentMethodVerification?.actualPaymentMethod ||
      payload.verification?.actualPaymentMethod ||
      payload.request?.paymentMethod;
    const verifiedMethodLabel =
      paymentMethodLabels[verifiedMethod] || verifiedMethod;
    const threeDSecure = payload.threeDSecureVerification;
    const vaultSetupEvidence = threeDSecure?.evidenceScope === 'vault_setup';
    const transactionAuthenticationDisclaimed =
      vaultSetupEvidence || threeDSecure?.transactionAuthenticated === false;
    const vaultSetupVerified = Boolean(
      passed && vaultSetupEvidence && threeDSecure?.performed === true
    );
    const transactionThreeDSecureVerified = Boolean(
      passed &&
      threeDSecure?.required &&
      !transactionAuthenticationDisclaimed
    );
    elements.verificationCard.hidden = false;
    elements.verificationCard.classList.toggle('is-failed', !passed);
    elements.verificationIcon.textContent = passed ? '✓' : '!';
    elements.verificationTitle.textContent = passed
      ? vaultSetupVerified
        ? 'Route + vault setup verified'
        : transactionThreeDSecureVerified
          ? 'Route + card + 3D Secure verified'
          : verifiedMethodLabel
            ? 'Route + payment method verified'
            : 'Route verified against Braintree'
      : 'Gateway proof did not match';
    elements.verificationCopy.textContent =
      vaultSetupVerified
        ? 'Braintree returned the server-selected account, card, currency, and vault-setup 3D Secure evidence. That evidence applies to the recurring mandate, not this transaction.'
        : transactionThreeDSecureVerified
          ? 'Braintree returned the server-selected account, card, currency, and required liability shift.'
          : passed && transactionAuthenticationDisclaimed
            ? 'Braintree returned the server-selected account, payment method, and currency. No transaction-level 3D Secure authentication was recorded.'
            : passed && verifiedMethodLabel
              ? `Braintree returned ${verifiedMethodLabel} on the server-selected merchant account and currency.`
              : checks.find((check) => check.passed !== true)?.explanation ||
                payload.verification.explanation ||
      (passed
        ? 'Braintree returned the server-selected merchant account.'
        : 'The returned account, currency, or payment method did not match the resolved route.');
  }

  function renderControlPanelLink(payload) {
    if (
      typeof payload?.controlPanelUrl === 'string' &&
      payload.controlPanelUrl.startsWith('https://sandbox.braintreegateway.com/')
    ) {
      elements.controlPanelLink.href = payload.controlPanelUrl;
      if (elements.controlPanelLinkLabel) {
        const opensSubscription =
          Boolean(payload?.subscription) ||
          payload?.recurringModel === 'braintree_subscription' ||
          payload.controlPanelUrl.includes('/subscriptions/');
        elements.controlPanelLinkLabel.textContent = opensSubscription
          ? 'Open subscription in Sandbox Control Panel'
          : 'Open transaction in Sandbox Control Panel';
      }
      elements.controlPanelLink.hidden = false;
    }
  }

  function renderPaymentResult(payload, httpOk, outcomeUncertain = false) {
    setRunnerProgress('verify');
    if (payload?.route) {
      renderDecision(payload);
    }
    elements.resultJson.textContent = formatJson(payload.braintreeResult || payload.error || {});
    elements.resultDetails.open = true;

    renderThreeDSecureProof(payload);
    renderVerification(payload);

    renderControlPanelLink(payload);

    const auditWarning = payload.audit?.persisted === false
      ? payload.audit.warning || 'The local audit event could not be saved.'
      : null;

    if (httpOk && payload.success) {
      const actualOutcome = payload.demoOutcome?.actual;
      const expectedFailureObserved =
        payload.demoOutcome?.matched === true &&
        ['processor_declined', 'gateway_rejected'].includes(actualOutcome);
      const succeededMessage = expectedFailureObserved
        ? `${expectedOutcomeLabels[actualOutcome]} observed as expected. No payment was approved, and the returned route was verified.`
        : payload.transactionStatus === 'authorized'
          ? 'Sandbox authorization created and the returned route was verified. Capture or void it from the transaction log.'
          : `${paymentMethodLabels[payload.request?.paymentMethod] || 'Payment'} submitted and the returned route was verified.`;

      if (auditWarning) {
        freshPreviewRequired = true;
        setInspectorState('Verified · audit warning', 'preview');
        setCheckoutStatus(auditWarning, 'warning');
      } else {
        setInspectorState(
          expectedFailureObserved
            ? 'Expected outcome'
            : payload.transactionStatus === 'authorized'
              ? 'Authorized'
              : 'Submitted',
          'verified'
        );
        setCheckoutStatus(succeededMessage, 'success');
      }
      return;
    }

    if (
      payload.error?.code === 'THREE_D_SECURE_REQUIRED' ||
      payload.error?.code === 'THREE_D_SECURE_AUTHENTICATION_FAILED'
    ) {
      freshPreviewRequired = false;
      setRunnerProgress('pay');
      setThreeDSecureStatus('Authentication stopped before payment.', 'failed');
      setInspectorState('Authentication required', 'blocked');
      setCheckoutStatus(
        payload.error.message ||
          'Authentication stopped before payment. No gateway mutation was requested, so it is safe to try again.',
        'blocked'
      );
      return;
    }

    if (
      payload.error?.code === 'ROUTE_VERIFICATION_FAILED' ||
      payload.error?.code === 'PAYMENT_METHOD_VERIFICATION_FAILED' ||
      payload.error?.code === 'THREE_D_SECURE_VERIFICATION_FAILED'
    ) {
      freshPreviewRequired = true;
      setInspectorState(
        payload.error?.code === 'THREE_D_SECURE_VERIFICATION_FAILED'
          ? 'Transaction returned · 3DS mismatch'
          : 'Transaction returned · route mismatch',
        'blocked'
      );
      const mismatchMessage =
        payload.error.message ||
        'Braintree returned a transaction, but routing proof failed. Do not retry; inspect it in the Sandbox Control Panel and start a fresh preview.';
      setCheckoutStatus(
        auditWarning ? `${mismatchMessage} ${auditWarning}` : mismatchMessage,
        'blocked'
      );
      return;
    }

    if (payload.error?.code === 'UNEXPECTED_DEMO_OUTCOME') {
      freshPreviewRequired = true;
      setInspectorState('Unexpected outcome', 'blocked');
      setCheckoutStatus(
        payload.error.message ||
          'Braintree returned a different outcome than the selected Sandbox scenario. Start a fresh preview before retrying.',
        payload.paymentApproved ? 'warning' : 'blocked'
      );
      return;
    }

    const failureMessage =
      payload.error?.message ||
      payload.braintreeResult?.message ||
      'The sandbox payment was not completed.';
    const failedBeforeGateway = payload.error?.code === 'AUDIT_PERSISTENCE_FAILED';
    const gatewayOutcomeRequiresReview =
      outcomeUncertain || payload.error?.code === 'BRAINTREE_REQUEST_FAILED';

    if (auditWarning || gatewayOutcomeRequiresReview) {
      freshPreviewRequired = !failedBeforeGateway;
      setInspectorState(
        gatewayOutcomeRequiresReview ? 'Outcome requires review' : 'Not completed · audit warning',
        'blocked'
      );
      const retryWarning = gatewayOutcomeRequiresReview
        ? 'Do not retry until you have checked the Sandbox Control Panel; then start a fresh route preview.'
        : '';
      setCheckoutStatus(
        [failureMessage, auditWarning, retryWarning].filter(Boolean).join(' '),
        'warning'
      );
    } else {
      setInspectorState('Not completed', 'blocked');
      setCheckoutStatus(failureMessage, 'blocked');
    }
  }

  function renderRecurringProof(payload, fallbackModel) {
    if (!elements.recurringProof) return;

    const model = payload?.recurringModel || fallbackModel ||
      elements.recurringModel?.value || 'merchant_managed';
    elements.recurringProof.hidden = false;
    elements.recurringModelProof.textContent =
      recurringModelLabels[model] || model;
    elements.transactionSourceProof.textContent =
      payload?.transactionSource ||
      payload?.vaultUsage ||
      (model === 'braintree_subscription' ? 'Braintree-managed schedule' : '—');
  }

  function configureRecurringActions(model, payload) {
    const subscription = model === 'braintree_subscription';
    const subscriptionStatus = String(payload?.subscription?.status || '').toLowerCase();
    const paymentMethod =
      payload?.request?.paymentMethod || completedPaymentMethod || 'card';

    elements.recurringActions.hidden = false;
    elements.nextCycleButton.hidden = subscription;
    elements.vaultOneTimeButton.hidden =
      paymentMethod === paymentMethodPayPalId;
    elements.refreshSubscriptionButton.hidden = !subscription;
    elements.cancelSubscriptionButton.hidden =
      !subscription || ['canceled', 'cancelled', 'expired'].includes(subscriptionStatus);
    setRecurringActionButtonsDisabled(false);
  }

  function renderRecurringResult(payload, httpOk, outcomeUncertain = false) {
    setRunnerProgress('verify');
    if (payload?.route) renderDecision(payload);

    elements.resultJson.textContent = formatJson(
      payload?.braintreeResult || payload?.subscription || payload?.error || {}
    );
    elements.resultDetails.open = true;
    renderThreeDSecureProof(payload);
    renderVerification(payload);
    renderControlPanelLink(payload);

    const model = payload?.recurringModel ||
      elements.recurringModel?.value || 'merchant_managed';
    renderRecurringProof(payload, model);

    const auditWarning = payload?.audit?.persisted === false
      ? payload.audit.warning || 'The local audit event could not be saved.'
      : null;

    if (httpOk && payload?.success === true) {
      const eventId = typeof payload.auditEventId === 'string'
        ? payload.auditEventId.trim()
        : '';
      if (eventId !== '' && !auditWarning) {
        currentRecurringEventId = eventId;
        recurringStartCompleted = true;
        completedPaymentMethod =
          payload?.request?.paymentMethod || selectedPaymentMethod();
        setPaymentSetupAvailability(false);
        configureRecurringActions(model, payload);
        const methodLabel =
          paymentMethodLabels[completedPaymentMethod] || 'Payment method';
        elements.recurringActionStatus.textContent = model === 'braintree_subscription'
          ? 'Subscription created. View its live status or cancel it from here.'
          : completedPaymentMethod === paymentMethodPayPalId
            ? 'First billing cycle completed. The vaulted PayPal account is ready for the next recurring cycle.'
            : 'First billing cycle completed. The same vaulted card is ready for the next cycle or the one-time route.';
        setInspectorState(
          model === 'braintree_subscription' ? 'Subscription created' : 'First cycle verified',
          'verified'
        );
        setCheckoutStatus(
          model === 'braintree_subscription'
            ? `${methodLabel} vaulted and Braintree Subscription created on the verified recurring route.`
            : `${methodLabel} vaulted and first recurring transaction completed on the verified route.`,
          'success'
        );
      } else {
        freshPreviewRequired = true;
        elements.recurringActions.hidden = true;
        setInspectorState('Completed · audit unavailable', 'preview');
        setCheckoutStatus(
          auditWarning ||
            'Braintree completed the recurring request, but no trusted audit event is available. Do not retry.',
          'warning'
        );
      }
      return;
    }

    const message = payload?.error?.message ||
      payload?.braintreeResult?.message ||
      'The recurring request was not completed.';
    if (
      payload?.error?.code === 'THREE_D_SECURE_REQUIRED' ||
      payload?.error?.code === 'THREE_D_SECURE_AUTHENTICATION_FAILED'
    ) {
      freshPreviewRequired = false;
      setRunnerProgress('pay');
      setThreeDSecureStatus('Authentication stopped before vaulting.', 'failed');
      setInspectorState('Authentication required', 'blocked');
      setCheckoutStatus(message, 'blocked');
      return;
    }
    const retryUnsafe =
      outcomeUncertain ||
      payload?.retrySafe === false ||
      payload?.error?.code === 'ROUTE_VERIFICATION_FAILED' ||
      payload?.error?.code === 'BRAINTREE_REQUEST_FAILED';
    if (retryUnsafe) {
      freshPreviewRequired = true;
      setInspectorState('Outcome requires review', 'blocked');
      setCheckoutStatus(
        `${message} Do not retry until you have checked the Sandbox Control Panel and started a fresh preview.`,
        'warning'
      );
    } else {
      setInspectorState('Not completed', 'blocked');
      setCheckoutStatus(message, 'blocked');
    }
  }

  async function performRecurringAction(action) {
    if (!currentRecurringEventId || recurringActionRunning) return;

    if (
      action === 'subscription_cancel' &&
      typeof window.confirm === 'function' &&
      !window.confirm(
        'Cancel this Braintree Sandbox subscription? Future billing cycles will stop.'
      )
    ) {
      elements.recurringActionStatus.textContent =
        'Cancellation dismissed. The subscription was not changed.';
      return;
    }

    const encodedEventId = encodeURIComponent(currentRecurringEventId);
    const paths = {
      next_cycle: `/api/demo/recurring/events/${encodedEventId}/next-cycle`,
      one_time: `/api/demo/recurring/events/${encodedEventId}/one-time`,
      subscription_status: `/api/demo/recurring/subscriptions/${encodedEventId}`,
      subscription_cancel: `/api/demo/recurring/subscriptions/${encodedEventId}/cancel`,
    };
    const path = paths[action];
    if (!path) return;

    const mutatesGateway = action !== 'subscription_status';
    recurringActionRunning = true;
    setRecurringActionButtonsDisabled(true);
    elements.recurringActionStatus.textContent = action === 'subscription_status'
      ? 'Loading live subscription status…'
      : 'Sending the recurring action to Braintree…';

    try {
      const response = await requestJson(
        path,
        mutatesGateway ? { method: 'POST' } : { method: 'GET' }
      );
      if (!response.readable) {
        throw new Error('The server returned an unreadable response.');
      }

      const payload = response.data;
      if (payload.route) renderDecision(payload);
      renderThreeDSecureProof(payload);
      renderVerification(payload);
      renderRecurringProof(payload, elements.recurringModel?.value);
      renderControlPanelLink(payload);
      elements.resultJson.textContent = formatJson(
        payload.braintreeResult || payload.subscription || payload.error || {}
      );
      elements.resultDetails.open = true;

      if (!response.ok || response.data?.success !== true) {
        const error = new Error(
          response.data?.error?.message || 'The recurring action was not completed.'
        );
        error.retrySafe = response.data?.retrySafe;
        throw error;
      }

      if (action === 'next_cycle') {
        elements.recurringActionStatus.textContent =
          'Subsequent billing cycle completed as a recurring transaction.';
        setInspectorState('Next cycle verified', 'verified');
        setCheckoutStatus('Next billing cycle completed on the recurring route.', 'success');
      } else if (action === 'one_time') {
        elements.recurringActionStatus.textContent =
          'The same vaulted card completed a charge on the one-time route.';
        setInspectorState('Shared vault verified', 'verified');
        setCheckoutStatus('One vault, another server-resolved merchant account.', 'success');
      } else if (action === 'subscription_status') {
        const status = payload.subscription?.status || 'available';
        const nextDate = payload.subscription?.nextBillingDate;
        if (['canceled', 'cancelled', 'expired'].includes(
          String(status).trim().toLowerCase()
        )) {
          elements.cancelSubscriptionButton.hidden = true;
        }
        elements.recurringActionStatus.textContent = nextDate
          ? `Subscription status: ${status}. Next billing date: ${nextDate}.`
          : `Subscription status: ${status}.`;
        setInspectorState('Subscription refreshed', 'verified');
      } else {
        elements.recurringActionStatus.textContent =
          'Subscription canceled. Braintree will not run another billing cycle.';
        elements.cancelSubscriptionButton.hidden = true;
        if (typeof elements.recurringActionStatus?.focus === 'function') {
          elements.recurringActionStatus.setAttribute('tabindex', '-1');
          elements.recurringActionStatus.focus();
        }
        setInspectorState('Subscription canceled', 'verified');
        setCheckoutStatus('Braintree Subscription canceled.', 'success');
      }
    } catch (error) {
      const retrySafe = error?.retrySafe === true;
      elements.recurringActionStatus.textContent = mutatesGateway && !retrySafe
        ? `${error.message} The outcome may be ambiguous; do not retry before checking the Sandbox Control Panel.`
        : error.message;
      setInspectorState('Action not completed', 'blocked');
      if (mutatesGateway && !retrySafe) {
        freshPreviewRequired = true;
        setCheckoutStatus(elements.recurringActionStatus.textContent, 'warning');
        return;
      }
    } finally {
      recurringActionRunning = false;
      if (!freshPreviewRequired) setRecurringActionButtonsDisabled(false);
    }
  }

  function paypalIntentForCurrentMode() {
    return elements.transactionMode.value === 'authorize_only'
      ? 'authorize'
      : 'capture';
  }

  function paypalConfiguration(routePayload) {
    const flow = isRecurringIntent() ? 'vault' : 'checkout';
    const intent = flow === 'vault' ? 'tokenize' : paypalIntentForCurrentMode();
    const accountId = routePayload.route.account?.merchantAccountId || 'account';
    const key = [accountId, elements.currency.value, flow, intent].join('|');
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return {
      flow,
      intent,
      key,
      namespace: `PhonePalPayPal_${(hash >>> 0).toString(36)}`,
    };
  }

  async function loadPayPalSdk(paypalCheckoutInstance, configuration) {
    const cached = paypalSdkCache.get(configuration.key);
    if (cached?.paypal) return cached.paypal;

    const options = configuration.flow === 'vault'
      ? { vault: true, intent: 'tokenize' }
      : {
          currency: elements.currency.value,
          intent: configuration.intent,
        };
    options.dataAttributes = { namespace: configuration.namespace };

    await paypalCheckoutInstance.loadPayPalSDK(options);
    const paypal = window[configuration.namespace];
    if (!paypal?.Buttons) {
      throw new Error('The PayPal Sandbox button library did not become available.');
    }
    paypalSdkCache.set(configuration.key, {
      namespace: configuration.namespace,
      paypal,
    });
    return paypal;
  }

  function buildPayPalButton(
    paypal,
    paypalCheckoutInstance,
    generation,
    configuration
  ) {
    let submittedIntent = null;

    function beginApproval() {
      if (!validatePaymentAttempt()) {
        throw new Error('This payment is not ready to start.');
      }
      if (
        generation !== previewGeneration ||
        paymentRunning ||
        !isPayPalSelected()
      ) {
        throw new Error('This PayPal setup is no longer current. Preview the route again.');
      }
      submittedIntent = currentIntent();
      beginPaymentProcessing(submittedIntent, paymentMethodPayPalId, {
        invalidatePreview: false,
      });
    }

    const callbacks = {
      onApprove: async (data) => {
        if (
          generation !== previewGeneration ||
          paypalSdkConfigurationKey !== configuration.key ||
          !submittedIntent
        ) {
          finishPaymentProcessing();
          setCheckoutStatus(
            'That PayPal approval belongs to an older route. Nothing was sent; preview the route again.',
            'blocked'
          );
          return;
        }

        try {
          const paymentMethod = await paypalCheckoutInstance.tokenizePayment(data);
          await submitTokenizedPayment(
            paymentMethod.nonce,
            paymentMethodPayPalId,
            submittedIntent,
            { paymentAlreadyRunning: true }
          );
        } catch (error) {
          handleClientPaymentError(error, submittedIntent, false);
          finishPaymentProcessing();
        }
      },
      onCancel: () => {
        finishPaymentProcessing();
        setRunnerProgress('pay');
        setInspectorState('Route ready', 'ready');
        setCheckoutStatus('PayPal approval was canceled. No payment request was sent.', 'neutral');
      },
      onError: (error) => {
        handleClientPaymentError(error, submittedIntent || currentIntent(), false);
        finishPaymentProcessing();
      },
      style: {
        color: 'gold',
        height: 45,
        label: paymentMethodPayPalId,
        shape: 'rect',
      },
    };

    if (configuration.flow === 'vault') {
      callbacks.createBillingAgreement = () => {
        beginApproval();
        return paypalCheckoutInstance.createPayment({
          flow: 'vault',
          billingAgreementDescription: 'PhonePal Sandbox recurring billing agreement',
        });
      };
    } else {
      callbacks.createOrder = () => {
        beginApproval();
        return paypalCheckoutInstance.createPayment({
          flow: 'checkout',
          amount: submittedIntent.amount,
          currency: submittedIntent.currency,
          intent: configuration.intent,
        });
      };
    }

    return paypal.Buttons(callbacks);
  }

  async function preparePaymentMethod(routePayload, generation) {
    await teardownPaymentMethods();

    if (generation !== previewGeneration || !routePayload.route.matched) return;

    if (isPayPalSelected()) {
      await preparePayPal(routePayload, generation);
    } else {
      await prepareHostedFields(routePayload, generation);
    }
  }

  async function prepareHostedFields(routePayload, generation) {
    if (
      generation !== previewGeneration ||
      !routePayload.route.matched ||
      isPayPalSelected()
    ) {
      return;
    }

    if (!window.braintree?.client || !window.braintree?.hostedFields) {
      setCheckoutStatus('The secure Braintree card component could not be loaded.', 'blocked');
      setInspectorState('SDK unavailable', 'blocked');
      return;
    }

    if (
      threeDSecurePolicy === 'required' &&
      !window.braintree?.threeDSecure
    ) {
      setThreeDSecureStatus(
        'Required authentication is unavailable. No payment can be sent.',
        'failed'
      );
      setCheckoutStatus(
        'This route requires 3D Secure, but the Braintree authentication component did not load.',
        'blocked'
      );
      setInspectorState('3DS unavailable', 'blocked');
      return;
    }

    const tokenResponse = await postJson('/api/demo/client-token', currentIntent());
    if (generation !== previewGeneration) {
      return;
    }

    if (isCatalogUnavailable(tokenResponse.data)) {
      renderCatalogUnavailable(tokenResponse.data);
      return;
    }

    if (!tokenResponse.ok || !tokenResponse.data?.clientToken) {
      setCheckoutStatus(
        tokenResponse.data?.error?.message || 'A sandbox client authorization could not be created.',
        'blocked'
      );
      setInspectorState('Setup failed', 'blocked');
      return;
    }

    let pendingHostedFields = null;
    let pendingThreeDSecure = null;

    try {
      const client = await window.braintree.client.create({
        authorization: tokenResponse.data.clientToken,
      });

      if (generation !== previewGeneration) {
        return;
      }

      if (threeDSecurePolicy && window.braintree?.threeDSecure) {
        try {
          pendingThreeDSecure = await window.braintree.threeDSecure.create({
            client,
            version: 2
          });
        } catch {
          if (threeDSecurePolicy === 'required') {
            const setupError = new Error(
              'The required 3D Secure component could not be initialized.'
            );
            setupError.threeDSecureSetupFailure = true;
            throw setupError;
          }
          if (elements.threeDSecureEnabled) {
            elements.threeDSecureEnabled.checked = false;
          }
          setThreeDSecureStatus(
            'Optional authentication is unavailable. Plain card checkout remains available.',
            'unavailable'
          );
        }
      } else if (threeDSecurePolicy === 'optional') {
        if (elements.threeDSecureEnabled) {
          elements.threeDSecureEnabled.checked = false;
        }
        setThreeDSecureStatus(
          'Optional authentication is unavailable. Plain card checkout remains available.',
          'unavailable'
        );
      }

      if (generation !== previewGeneration) {
        await pendingThreeDSecure?.teardown?.();
        return;
      }

      pendingHostedFields = await window.braintree.hostedFields.create({
        client,
        styles: {
          input: {
            color: '#172b4d',
            'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            'font-size': '16px',
          },
          ':focus': { color: '#003087' },
          '.invalid': { color: '#b42318' },
          '.valid': { color: '#116348' },
          '::placeholder': { color: '#8793a8' },
        },
        fields: {
          number: {
            container: '#card-number',
            placeholder: disputeScenarioSelected
              ? disputeSandboxCardNumber
              : useThreeDSecureForCard()
                ? threeDSecureScenarios[selectedThreeDSecureScenario()].cardNumber
                : standardSandboxCardNumber,
          },
          expirationDate: {
            container: '#expiration-date',
            placeholder: 'MM / YY',
          },
          cvv: {
            container: '#cvv',
            placeholder: '123',
          },
        },
      });

      if (generation !== previewGeneration) {
        await pendingHostedFields.teardown();
        await pendingThreeDSecure?.teardown?.();
        return;
      }

      hostedFieldsInstance = pendingHostedFields;
      threeDSecureInstance = pendingThreeDSecure;
      pendingHostedFields = null;
      pendingThreeDSecure = null;
      freshPreviewRequired = false;
      updateRunButtonLabel();
      setPaymentSetupAvailability(true);
      setRunnerProgress('pay');
      if (threeDSecureInstance) {
        setThreeDSecureStatus(
          threeDSecurePolicy === 'required'
            ? 'Ready. Authentication and liability shift are required before payment.'
            : elements.threeDSecureEnabled?.checked
              ? 'Ready to authenticate after tokenization.'
              : 'Optional authentication is off for this attempt.',
          'ready'
        );
      }
      if (isSubscriptionModel() && !hasPlansForSelectedCurrency()) {
        setCheckoutStatus(
          `Secure card fields are ready, but no plan is available for ${elements.currency.value}. Model A remains available.`,
          'preview'
        );
      } else {
        setCheckoutStatus(
          isRecurringIntent()
            ? 'Secure card fields ready. The server will verify and vault the card on the resolved recurring account.'
            : 'Secure card fields ready. No card data touches this server.',
          'success'
        );
      }
    } catch (error) {
      try {
        await pendingHostedFields?.teardown?.();
      } catch {
        // A partially initialized Hosted Fields instance can already be gone.
      }
      try {
        await pendingThreeDSecure?.teardown?.();
      } catch {
        // A partially initialized 3D Secure instance can already be gone.
      }
      setPaymentSetupAvailability(false);
      if (error?.threeDSecureSetupFailure) {
        setThreeDSecureStatus(
          'Required authentication could not be initialized. No payment can be sent.',
          'failed'
        );
        setCheckoutStatus(
          'This route requires 3D Secure, but its authentication component could not be initialized.',
          'blocked'
        );
        setInspectorState('3DS setup failed', 'blocked');
      } else {
        setCheckoutStatus('Secure card fields could not be initialized. Preview remains available.', 'blocked');
        setInspectorState('Setup failed', 'blocked');
      }
    }
  }

  async function preparePayPal(routePayload, generation) {
    if (
      generation !== previewGeneration ||
      !routePayload.route.matched ||
      !isPayPalSelected()
    ) {
      return;
    }

    if (!window.braintree?.client || !window.braintree?.paypalCheckout) {
      setCheckoutStatus('The Braintree PayPal component could not be loaded.', 'blocked');
      setInspectorState('SDK unavailable', 'blocked');
      return;
    }

    const tokenResponse = await postJson('/api/demo/client-token', currentIntent());
    if (generation !== previewGeneration) return;

    if (isCatalogUnavailable(tokenResponse.data)) {
      renderCatalogUnavailable(tokenResponse.data);
      return;
    }
    if (!tokenResponse.ok || !tokenResponse.data?.clientToken) {
      setCheckoutStatus(
        tokenResponse.data?.error?.message || 'A PayPal client authorization could not be created.',
        'blocked'
      );
      setInspectorState('Setup failed', 'blocked');
      return;
    }

    try {
      const client = await window.braintree.client.create({
        authorization: tokenResponse.data.clientToken,
      });
      if (generation !== previewGeneration) return;

      const instance = await window.braintree.paypalCheckout.create({ client });
      if (generation !== previewGeneration) {
        await instance.teardown();
        return;
      }

      paypalCheckoutInstance = instance;
      const configuration = paypalConfiguration(routePayload);
      paypalSdkConfigurationKey = configuration.key;
      const paypal = await loadPayPalSdk(paypalCheckoutInstance, configuration);
      if (
        generation !== previewGeneration ||
        paypalSdkConfigurationKey !== configuration.key ||
        !isPayPalSelected()
      ) {
        await instance.teardown();
        return;
      }

      const button = buildPayPalButton(
        paypal,
        paypalCheckoutInstance,
        generation,
        configuration
      );
      if (typeof button.isEligible === 'function' && !button.isEligible()) {
        throw new Error('PayPal is not eligible in this browser.');
      }
      await button.render('#paypal-button');
      if (generation !== previewGeneration || !isPayPalSelected()) {
        if (typeof button.close === 'function') await button.close();
        return;
      }

      paypalButtonInstance = button;
      freshPreviewRequired = false;
      setPaymentSetupAvailability(true);
      setRunnerProgress('pay');
      if (elements.paypalFlowCopy) {
        elements.paypalFlowCopy.textContent = isRecurringIntent()
          ? 'Approve a Sandbox billing agreement. Braintree will return a nonce for the server-owned vault route.'
          : `Approve this ${elements.currency.value} payment in PayPal Sandbox. Braintree will tokenize the approval.`;
      }
      setCheckoutStatus(
        isRecurringIntent()
          ? 'PayPal is ready. Approve the billing agreement to start the verified recurring route.'
          : 'PayPal is ready. Approve the payment in the secure Sandbox window.',
        'success'
      );
    } catch (error) {
      await teardownPayPal();
      setPaymentSetupAvailability(false);
      setCheckoutStatus(
        error?.message || 'The PayPal Sandbox button could not be initialized.',
        'blocked'
      );
      setInspectorState('Setup failed', 'blocked');
    }
  }

  async function previewRoute() {
    const generation = ++previewGeneration;
    resetTransactionProof();
    renderResolvingState();
    paymentMethodRouteReady = false;
    setPaymentSetupAvailability(false);
    if (elements.paymentMethodAvailability) {
      elements.paymentMethodAvailability.textContent =
        'Checking methods for the server-selected account…';
    }
    setInspectorState('Resolving', 'waiting');
    setCheckoutStatus('Asking the server to evaluate the configured policy…');
    setRunnerProgress('preview');

    try {
      const response = await postJson('/api/demo/route-preview', currentIntent());
      if (generation !== previewGeneration) {
        return;
      }

      if (isCatalogUnavailable(response.data)) {
        await schedulePaymentMethodTeardown();
        renderCatalogUnavailable(response.data);
        return;
      }

      if (!response.ok || !response.data?.route) {
        throw new Error(
          response.data?.error?.message || 'Route preview unavailable'
        );
      }

      renderDecision(response.data);
      await schedulePaymentMethodPreparation(response.data, generation);
    } catch (error) {
      if (generation !== previewGeneration) {
        return;
      }
      await schedulePaymentMethodTeardown();
      setInspectorState('Unavailable', 'blocked');
      setCheckoutStatus(
        error?.message || 'The route preview could not be loaded. Check that the server is running.',
        'blocked'
      );
    }
  }

  function selectManualScenario() {
    elements.scenarioId.value = 'manual';
    disputeScenarioSelected = false;
    refreshPaymentMethodPresentation();
    for (const preset of elements.presets) {
      preset.classList.remove('is-selected');
      preset.setAttribute('aria-pressed', 'false');
    }
  }

  function selectCardForUnknownRoute() {
    if (!isPayPalSelected()) return;
    elements.paymentMethodCard.checked = true;
    elements.paymentMethodPayPal.checked = false;
    updateRunButtonLabel();
    refreshPaymentMethodPresentation();
  }

  function handlePaymentMethodChange() {
    if (
      isPayPalSelected() &&
      !availablePaymentMethods.has(paymentMethodPayPalId)
    ) {
      selectCardForUnknownRoute();
      setCheckoutStatus(
        'PayPal is not enabled for this server-selected account.',
        'blocked'
      );
      return;
    }

    selectManualScenario();
    if (isPayPalSelected()) {
      elements.expectedOutcome.value = 'approved';
      disputeScenarioSelected = false;
      updateExpectedOutcomeConfiguration({ resetAmount: true });
    }
    updateRecurringConfiguration();
    updateRunButtonLabel();
    refreshPaymentMethodPresentation();
    previewRoute();
  }

  for (const preset of elements.presets) {
    preset.addEventListener('click', () => {
      if (preset.disabled) return;
      const switchesToCard = isPayPalSelected();
      const usesCardTrigger =
        (preset.dataset.expectedOutcome || 'approved') !== 'approved' ||
        preset.dataset.disputeScenario === 'true';
      selectCardForUnknownRoute();
      for (const candidate of elements.presets) {
        candidate.classList.toggle('is-selected', candidate === preset);
        candidate.setAttribute('aria-pressed', candidate === preset ? 'true' : 'false');
      }

      elements.scenarioId.value = preset.dataset.scenarioId;
      elements.currency.value = preset.dataset.currency;
      elements.paymentType.value = preset.dataset.paymentType;
      elements.transactionMode.value =
        preset.dataset.transactionMode || 'submit_for_settlement';
      elements.expectedOutcome.value = preset.dataset.expectedOutcome || 'approved';
      if (elements.advancedOptions) {
        elements.advancedOptions.open =
          elements.transactionMode.value === 'authorize_only' ||
          elements.expectedOutcome.value !== 'approved';
      }
      disputeScenarioSelected = preset.dataset.disputeScenario === 'true';
      if (elements.recurringModel) {
        elements.recurringModel.value =
          preset.dataset.recurringModel || 'merchant_managed';
      }
      elements.amount.value = preset.dataset.amount;
      updateCurrencyConfiguration();
      updateRecurringConfiguration();
      previewRoute();
      if (switchesToCard) {
        setCheckoutStatus(
          usesCardTrigger
            ? 'Card selected because this scenario uses a Sandbox card trigger. Previewing its route…'
            : 'Card selected while this preset route is rechecked…'
        );
      }
    });
  }

  elements.currency.addEventListener('change', () => {
    selectManualScenario();
    selectCardForUnknownRoute();
    updateCurrencyConfiguration({ resetAmount: true });
    updateRecurringConfiguration();
    previewRoute();
  });

  elements.paymentType.addEventListener('change', () => {
    selectManualScenario();
    selectCardForUnknownRoute();
    if (isRecurringIntent()) {
      updateCurrencyConfiguration({ resetAmount: true });
    }
    updateRecurringConfiguration({ announce: true });
    previewRoute();
  });

  elements.recurringModel?.addEventListener('change', () => {
    selectManualScenario();
    resetTransactionProof();
    updateRecurringConfiguration({ announce: true });
    previewRoute();
  });

  elements.planId?.addEventListener('change', () => {
    selectManualScenario();
    resetTransactionProof();
    updatePlanAvailability();
    syncSubscriptionPlanPrice();
    updateRunButtonLabel();
    refreshPaymentMethodPresentation();
    if (elements.planId.value) {
      setCheckoutStatus('Plan selected. The recurring route is ready to create a Braintree Subscription.');
    }
  });

  elements.transactionMode.addEventListener('change', () => {
    selectManualScenario();
    updateRunButtonLabel();
    previewRoute();
  });

  elements.expectedOutcome.addEventListener('change', () => {
    selectManualScenario();
    updateExpectedOutcomeConfiguration();
    previewRoute();
  });

  elements.paymentMethodCard?.addEventListener('change', handlePaymentMethodChange);
  elements.paymentMethodPayPal?.addEventListener('change', handlePaymentMethodChange);
  elements.threeDSecureEnabled?.addEventListener('change', () => {
    resetTransactionProof();
    updateRunButtonLabel();
    updateThreeDSecurePresentation();
    setThreeDSecureStatus(
      elements.threeDSecureEnabled.checked
        ? 'Ready to authenticate after tokenization.'
        : 'Optional authentication is off for this attempt.',
      'ready'
    );
  });
  for (const option of elements.threeDSecureScenarioOptions) {
    option.addEventListener('change', () => {
      resetTransactionProof();
      refreshThreeDSecureScenarioHint();
      setThreeDSecureStatus(
        `${threeDSecureScenarios[selectedThreeDSecureScenario()].label} selected. Ready to authenticate.`,
        'ready'
      );
    });
  }

  elements.amount.addEventListener('input', () => {
    selectManualScenario();
    resetTransactionProof();
    setCheckoutStatus(
      freshPreviewRequired
        ? 'Amount changed. Complete a fresh route preview before another payment.'
        : 'Amount changed. Preview the route or run a new payment for fresh proof.'
    );
  });
  elements.previewButton.addEventListener('click', previewRoute);

  elements.nextCycleButton?.addEventListener('click', () =>
    performRecurringAction('next_cycle')
  );
  elements.vaultOneTimeButton?.addEventListener('click', () =>
    performRecurringAction('one_time')
  );
  elements.refreshSubscriptionButton?.addEventListener('click', () =>
    performRecurringAction('subscription_status')
  );
  elements.cancelSubscriptionButton?.addEventListener('click', () =>
    performRecurringAction('subscription_cancel')
  );

  function validatePaymentAttempt() {
    if (freshPreviewRequired) {
      setCheckoutStatus(
        'Start a fresh route preview before attempting another payment.',
        'blocked'
      );
      return false;
    }

    if (isRecurringIntent() && recurringStartCompleted) {
      setCheckoutStatus(
        'This recurring start already completed. Use its follow-up controls or start a fresh route preview.',
        'blocked'
      );
      return false;
    }

    if (!selectedPlanAvailable()) {
      setCheckoutStatus(
        `No plan available for ${elements.currency.value}. Choose Model A to keep the recurring demo usable.`,
        'blocked'
      );
      return false;
    }
    return true;
  }

  function beginPaymentProcessing(
    submittedIntent,
    paymentMethod,
    { invalidatePreview = true } = {}
  ) {
    paymentRunning = true;
    if (invalidatePreview) previewGeneration += 1;
    form.setAttribute('aria-busy', 'true');
    elements.runButton.disabled = true;
    elements.runButton.setAttribute('aria-busy', 'true');
    if (elements.runButtonLabel) {
      elements.runButtonLabel.textContent = 'Processing…';
    }
    setIntentControlsDisabled(true);
    refreshPaymentMethodPresentation();
    setInspectorState('Processing', 'waiting');
    setRunnerProgress('pay');

    const recurring = submittedIntent.paymentType === 'recurring';
    const methodLabel = paymentMethodLabels[paymentMethod] || 'payment method';
    setCheckoutStatus(
      paymentMethod === paymentMethodCardId && useThreeDSecureForCard()
        ? recurring
          ? 'Tokenizing the card, then authenticating it before any vault request…'
          : 'Tokenizing the card, then authenticating it before any payment request…'
        : recurring
          ? `Tokenizing ${methodLabel}, verifying the vault route, and starting recurring billing…`
          : `Tokenizing ${methodLabel} before the routed Sandbox payment…`
    );
  }

  function finishPaymentProcessing() {
    paymentRunning = false;
    form.removeAttribute('aria-busy');
    elements.runButton.removeAttribute('aria-busy');
    setIntentControlsDisabled(catalogUnavailable);
    refreshPaymentMethodPresentation();
    updateRunButtonLabel();
  }

  function createThreeDSecureClientError(message) {
    const error = new Error(message);
    error.threeDSecureFailure = true;
    return error;
  }

  async function verifyCardWithThreeDSecure(
    paymentMethod,
    submittedIntent,
    generation
  ) {
    if (generation !== previewGeneration || !paymentRunning) {
      throw createThreeDSecureClientError(
        'That card token belongs to an older route. No payment request was sent.'
      );
    }
    if (!useThreeDSecureForCard()) return paymentMethod.nonce;
    if (!threeDSecureInstance) {
      throw createThreeDSecureClientError(
        '3D Secure is not ready. Preview the route and try again.'
      );
    }
    if (
      typeof paymentMethod?.nonce !== 'string' ||
      typeof paymentMethod?.details?.bin !== 'string' ||
      paymentMethod.details.bin.trim() === ''
    ) {
      throw createThreeDSecureClientError(
        'The tokenized card did not include the details needed for authentication.'
      );
    }

    setThreeDSecureStatus('Authenticating with the card issuer…', 'authenticating');
    setCheckoutStatus(
      'Authenticating the card. Complete the issuer challenge if Braintree opens one…'
    );

    let verification;
    try {
      verification = await threeDSecureInstance.verifyCard({
        amount: submittedIntent.amount,
        nonce: paymentMethod.nonce,
        bin: paymentMethod.details.bin,
        collectDeviceData: true,
        onLookupComplete(_data, next) {
          setThreeDSecureStatus(
            'Issuer lookup complete. Complete any challenge to continue.',
            'authenticating'
          );
          next();
        },
      });
    } catch {
      throw createThreeDSecureClientError(
        'Authentication was canceled or did not complete. No payment request was sent.'
      );
    }

    if (generation !== previewGeneration || !paymentRunning) {
      throw createThreeDSecureClientError(
        'That authentication belongs to an older route. No payment request was sent.'
      );
    }
    if (typeof verification?.nonce !== 'string' || verification.nonce.trim() === '') {
      throw createThreeDSecureClientError(
        'Authentication did not return an upgraded payment method. No payment request was sent.'
      );
    }
    const explicitFailedScenario = selectedThreeDSecureScenario() === 'failed';
    if (
      (threeDSecurePolicy === 'required' || explicitFailedScenario) &&
      verification.liabilityShifted !== true
    ) {
      throw createThreeDSecureClientError(
        explicitFailedScenario
          ? 'Authentication failed as selected. No payment request was sent.'
          : 'Authentication did not produce the liability shift required by this route. No payment request was sent.'
      );
    }

    setThreeDSecureStatus(
      'Authentication completed. The server will independently verify the upgraded nonce.',
      'authenticated'
    );
    return verification.nonce;
  }

  function handleClientPaymentError(error, submittedIntent, gatewayRequestStarted) {
    const submittedRecurring = submittedIntent?.paymentType === 'recurring';
    if (gatewayRequestStarted) {
      freshPreviewRequired = true;
      setInspectorState('Outcome unknown', 'blocked');
      setCheckoutStatus(
        submittedRecurring
          ? 'The recurring request was sent, but its result could not be confirmed. Do not retry; check the Sandbox Control Panel, then start a fresh route preview.'
          : 'The payment request was sent, but its result could not be confirmed. Do not retry; check the Sandbox Control Panel, then start a fresh route preview.',
        'blocked'
      );
      return;
    }

    if (error?.threeDSecureFailure) {
      setThreeDSecureStatus('Authentication stopped before payment.', 'failed');
      setInspectorState('Authentication stopped', 'blocked');
      setRunnerProgress('pay');
      setCheckoutStatus(
        error.message ||
          'Authentication stopped before payment. No request was sent, so it is safe to try again.',
        'blocked'
      );
      return;
    }

    setInspectorState('Not completed', 'blocked');
    setRunnerProgress('pay');
    const invalidFieldKeys = Array.isArray(error?.details?.invalidFieldKeys)
      ? error.details.invalidFieldKeys
      : [];
    const invalidFields = invalidFieldKeys.length > 0
      ? invalidFieldKeys
          .map((field) => ({
            number: 'card number',
            expirationDate: 'expiry date',
            cvv: 'security code',
          })[field] || field)
      : [];
    const paypalSelected =
      submittedIntent?.paymentMethod === paymentMethodPayPalId;
    setCheckoutStatus(
      invalidFields.length > 0
        ? `Check the ${invalidFields.join(', ')} and try again.`
        : paypalSelected
          ? error?.message || 'PayPal approval was not completed. You can safely try again.'
          : submittedRecurring
            ? 'Recurring billing could not start. Check the Sandbox card fields and try again.'
            : 'The payment could not be completed. Check the Sandbox card fields and try again.',
      'blocked'
    );
    if (
      invalidFieldKeys.length > 0 &&
      typeof hostedFieldsInstance?.focus === 'function'
    ) {
      try {
        hostedFieldsInstance.focus(invalidFieldKeys[0], () => undefined);
      } catch {
        // The status message remains the fallback if the hosted iframe cannot focus.
      }
    }
  }

  async function submitTokenizedPayment(
    nonce,
    paymentMethod,
    submittedIntent,
    { paymentAlreadyRunning = false } = {}
  ) {
    if (!paymentAlreadyRunning) {
      beginPaymentProcessing(submittedIntent, paymentMethod);
    }
    const submittedRecurring = submittedIntent.paymentType === 'recurring';
    let gatewayRequestStarted = false;

    try {
      setInspectorState('Submitting', 'waiting');
      const authenticatedCard =
        paymentMethod === paymentMethodCardId && useThreeDSecureForCard();
      setCheckoutStatus(
        authenticatedCard
          ? submittedRecurring
            ? 'Authentication complete. Sending the server-owned vault and recurring request…'
            : 'Authentication complete. Sending the routed Sandbox payment…'
          : submittedRecurring
            ? 'Payment method tokenized. Sending the server-owned vault and recurring request…'
            : 'Payment method tokenized. Sending the routed Sandbox payment…'
      );
      gatewayRequestStarted = true;
      const response = submittedRecurring
        ? await postJson(
            '/api/demo/recurring/start',
            recurringStartRequest(nonce, submittedIntent)
          )
        : await postJson('/api/demo/payments/one-time', {
            ...submittedIntent,
            paymentMethod,
            paymentMethodNonce: nonce,
          });

      if (isCatalogUnavailable(response.data)) {
        renderCatalogUnavailable(response.data);
        return;
      }

      const outcomeUncertain =
        !response.readable ||
        (response.status >= 500 &&
          response.data?.error?.code !== 'AUDIT_PERSISTENCE_FAILED' &&
          response.data?.retrySafe !== true);
      if (submittedRecurring) {
        renderRecurringResult(response.data, response.ok, outcomeUncertain);
      } else {
        renderPaymentResult(response.data, response.ok, outcomeUncertain);
      }
    } catch (error) {
      handleClientPaymentError(error, submittedIntent, gatewayRequestStarted);
    } finally {
      finishPaymentProcessing();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!validatePaymentAttempt()) return;
    if (isPayPalSelected()) {
      setCheckoutStatus('Use the PayPal button to approve this payment.', 'blocked');
      return;
    }

    if (!form.reportValidity() || !hostedFieldsInstance || paymentRunning) {
      if (!hostedFieldsInstance) {
        setCheckoutStatus('Wait for the secure card fields and complete the card details.', 'blocked');
      }
      return;
    }

    const submittedIntent = currentIntent();
    beginPaymentProcessing(submittedIntent, 'card');
    const attemptGeneration = previewGeneration;

    try {
      const paymentMethod = await hostedFieldsInstance.tokenize();
      const paymentMethodNonce = await verifyCardWithThreeDSecure(
        paymentMethod,
        submittedIntent,
        attemptGeneration
      );
      await submitTokenizedPayment(
        paymentMethodNonce,
        'card',
        submittedIntent,
        { paymentAlreadyRunning: true }
      );
    } catch (error) {
      handleClientPaymentError(error, submittedIntent, false);
    } finally {
      if (paymentRunning) finishPaymentProcessing();
    }
  });

  for (const button of elements.refreshButtons) {
    button.addEventListener('click', refreshCatalog);
  }

  updateCurrencyConfiguration();
  updateRecurringConfiguration();
  if (!catalogAvailableAtLoad) {
    renderCatalogUnavailable({
      error: {
        code: 'CATALOG_UNAVAILABLE',
        message: 'Gateway unavailable. Retry merchant account discovery to enable this demo.',
      },
    });
    return;
  }

  previewRoute();
})();
