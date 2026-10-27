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
    amount: document.querySelector('#amount'),
    currencyPrefix: document.querySelector('#currency-prefix'),
    demoRate: document.querySelector('#demo-rate'),
    sandboxOutcomeNotice: document.querySelector('#sandbox-outcome-notice'),
    presets: Array.from(document.querySelectorAll('.scenario-preset')),
    refreshButtons: Array.from(document.querySelectorAll('[data-catalog-refresh]')),
    refreshStatuses: Array.from(document.querySelectorAll('[data-refresh-status]')),
    staleCatalogContent: Array.from(
      document.querySelectorAll('[data-catalog-stale-content]')
    ),
    previewButton: document.querySelector('#preview-route'),
    runButton: document.querySelector('#run-payment'),
    runButtonLabel: document.querySelector('#run-payment-label'),
    cardFields: document.querySelector('#card-fields'),
    cardHint: document.querySelector('#sandbox-card-hint'),
    checkoutStatus: document.querySelector('#checkout-status'),
    stageThreeNotice: document.querySelector('#stage-three-notice'),
    noRouteNotice: document.querySelector('#no-route-notice'),
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
    controlPanelLink: document.querySelector('#control-panel-link'),
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

  let hostedFieldsInstance = null;
  let hostedFieldsLifecycle = Promise.resolve();
  let previewGeneration = 0;
  let paymentRunning = false;
  let freshPreviewRequired = false;
  let catalogUnavailable = !catalogAvailableAtLoad;

  function currentIntent() {
    return {
      scenarioId: elements.scenarioId.value,
      currency: elements.currency.value,
      paymentType: elements.paymentType.value,
      amount: elements.amount.value,
      transactionMode: elements.transactionMode.value,
      expectedOutcome: elements.expectedOutcome.value,
    };
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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

  function setCardAvailability(available) {
    elements.cardFields.disabled = !available;
    elements.cardFields.classList.toggle('is-disabled', !available);
    elements.cardHint.hidden = !available;
    elements.runButton.disabled = !available || paymentRunning || freshPreviewRequired;
  }

  function setIntentControlsDisabled(disabled) {
    elements.paymentType.disabled = disabled;
    elements.currency.disabled = disabled;
    elements.transactionMode.disabled = disabled;
    elements.expectedOutcome.disabled = disabled;
    elements.amount.disabled = disabled;
    elements.previewButton.disabled = disabled;
    for (const preset of elements.presets) {
      preset.disabled = disabled;
    }
  }

  function selectedCurrencyOption() {
    return Array.from(elements.currency.options || []).find(
      (option) => option.value === elements.currency.value
    );
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
    const expectedOutcome = elements.expectedOutcome.value;
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

    if (expectedOutcome === 'processor_declined') {
      elements.runButtonLabel.textContent = 'Run expected processor decline';
    } else if (expectedOutcome === 'gateway_rejected') {
      elements.runButtonLabel.textContent = 'Run expected gateway rejection';
    } else if (elements.transactionMode.value === 'authorize_only') {
      elements.runButtonLabel.textContent = 'Authorize sandbox payment';
    } else {
      elements.runButtonLabel.textContent = 'Run sandbox payment';
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
    setCardAvailability(false);
    setIntentControlsDisabled(true);
    elements.intentSummary.textContent = '—';
    elements.accountSummary.textContent = 'No catalog';
    elements.routeReason.textContent = message;
    elements.requestJson.textContent = '{}';
    renderTrace([]);
    resetTransactionProof();
    elements.noRouteNotice.hidden = true;
    elements.stageThreeNotice.hidden = true;
    setInspectorState('Unavailable', 'blocked');
    setCheckoutStatus(message, 'blocked');
  }

  function setRefreshStatus(message) {
    for (const status of elements.refreshStatuses) {
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
        await scheduleHostedFieldsTeardown();
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
      await scheduleHostedFieldsTeardown();
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
    setCardAvailability(false);

    if (instance && typeof instance.teardown === 'function') {
      try {
        await instance.teardown();
      } catch {
        // The containers are rebuilt by the next Hosted Fields initialization.
      }
    }
  }

  function scheduleHostedFieldsPreparation(routePayload, generation) {
    hostedFieldsLifecycle = hostedFieldsLifecycle
      .catch(() => undefined)
      .then(() => prepareHostedFields(routePayload, generation));
    return hostedFieldsLifecycle;
  }

  function scheduleHostedFieldsTeardown() {
    hostedFieldsLifecycle = hostedFieldsLifecycle
      .catch(() => undefined)
      .then(() => teardownHostedFields());
    return hostedFieldsLifecycle;
  }

  function resetTransactionProof() {
    elements.verificationCard.hidden = true;
    elements.verificationCard.classList.remove('is-failed');
    elements.resultJson.textContent = 'No transaction has been sent.';
    elements.resultDetails.open = false;
    elements.controlPanelLink.hidden = true;
    elements.controlPanelLink.removeAttribute('href');
  }

  function renderResolvingState() {
    const intent = currentIntent();
    const mode = transactionModeLabels[intent.transactionMode] || intent.transactionMode;
    elements.intentSummary.textContent = `${intent.currency} · ${paymentTypeLabels[intent.paymentType] || intent.paymentType} · ${mode}`;
    elements.accountSummary.textContent = 'Resolving…';
    elements.routeReason.textContent = 'The server is evaluating every configured merchant account.';
    elements.requestJson.textContent = '{}';
    elements.stageThreeNotice.hidden = true;
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

      const copy = document.createElement('div');
      const account = document.createElement('strong');
      account.textContent = entry.account;
      const explanation = document.createElement('span');
      explanation.textContent = entry.why;
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

    elements.intentSummary.textContent = [
      route.intent.currency || '—',
      paymentType || '—',
      transactionMode,
    ].filter(Boolean).join(' · ');
    elements.accountSummary.textContent = route.matched
      ? `${route.account.label} · ${route.account.merchantAccountId}`
      : 'No route';
    elements.routeReason.textContent = route.reason;
    elements.requestJson.textContent = formatJson(request);
    renderTrace(route.trace);

    const recurring = route.intent.paymentType === 'recurring';
    elements.stageThreeNotice.hidden = !recurring;
    elements.noRouteNotice.hidden = route.matched;

    if (!route.matched) {
      setInspectorState('No route', 'blocked');
      setCheckoutStatus('No gateway call will be made for this intent.', 'blocked');
    } else if (recurring) {
      setInspectorState('Preview only', 'preview');
      setCheckoutStatus('Route resolved. Execution waits for Stage 3 vaulting.', 'preview');
    } else {
      setInspectorState('Route ready', 'ready');
      setCheckoutStatus('Route resolved. Loading secure card fields…');
    }
  }

  function renderPaymentResult(payload, httpOk, outcomeUncertain = false) {
    if (payload?.route) {
      renderDecision(payload);
    }
    elements.resultJson.textContent = formatJson(payload.braintreeResult || payload.error || {});
    elements.resultDetails.open = true;

    if (payload.verification) {
      const passed = payload.verification.passed === true;
      elements.verificationCard.hidden = false;
      elements.verificationCard.classList.toggle('is-failed', !passed);
      elements.verificationIcon.textContent = passed ? '✓' : '!';
      elements.verificationTitle.textContent = passed
        ? 'Route verified against Braintree'
        : 'Route verification failed';
      elements.verificationCopy.textContent = payload.verification.explanation;
    }

    if (
      typeof payload.controlPanelUrl === 'string' &&
      payload.controlPanelUrl.startsWith('https://sandbox.braintreegateway.com/')
    ) {
      elements.controlPanelLink.href = payload.controlPanelUrl;
      elements.controlPanelLink.hidden = false;
    }

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
          : 'Sandbox payment submitted and the returned route was verified.';

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

    if (payload.error?.code === 'ROUTE_VERIFICATION_FAILED') {
      freshPreviewRequired = true;
      setInspectorState('Transaction returned · route mismatch', 'blocked');
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

  async function prepareHostedFields(routePayload, generation) {
    await teardownHostedFields();

    if (
      generation !== previewGeneration ||
      !routePayload.route.matched ||
      routePayload.route.intent.paymentType !== 'one_time'
    ) {
      return;
    }

    if (!window.braintree?.client || !window.braintree?.hostedFields) {
      setCheckoutStatus('The secure Braintree card component could not be loaded.', 'blocked');
      setInspectorState('SDK unavailable', 'blocked');
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

    try {
      const client = await window.braintree.client.create({
        authorization: tokenResponse.data.clientToken,
      });

      if (generation !== previewGeneration) {
        return;
      }

      const instance = await window.braintree.hostedFields.create({
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
            placeholder: '4111 1111 1111 1111',
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
        await instance.teardown();
        return;
      }

      hostedFieldsInstance = instance;
      freshPreviewRequired = false;
      setCardAvailability(true);
      setCheckoutStatus('Secure card fields ready. No card data touches this server.', 'success');
    } catch {
      setCardAvailability(false);
      setCheckoutStatus('Secure card fields could not be initialized. Preview remains available.', 'blocked');
      setInspectorState('Setup failed', 'blocked');
    }
  }

  async function previewRoute() {
    const generation = ++previewGeneration;
    resetTransactionProof();
    renderResolvingState();
    setCardAvailability(false);
    setInspectorState('Resolving', 'waiting');
    setCheckoutStatus('Asking the server to evaluate the configured policy…');

    try {
      const response = await postJson('/api/demo/route-preview', currentIntent());
      if (generation !== previewGeneration) {
        return;
      }

      if (isCatalogUnavailable(response.data)) {
        await scheduleHostedFieldsTeardown();
        renderCatalogUnavailable(response.data);
        return;
      }

      if (!response.ok || !response.data?.route) {
        throw new Error('Route preview unavailable');
      }

      renderDecision(response.data);
      await scheduleHostedFieldsPreparation(response.data, generation);
    } catch {
      if (generation !== previewGeneration) {
        return;
      }
      await scheduleHostedFieldsTeardown();
      setInspectorState('Unavailable', 'blocked');
      setCheckoutStatus('The route preview could not be loaded. Check that the server is running.', 'blocked');
    }
  }

  function selectManualScenario() {
    elements.scenarioId.value = 'manual';
    for (const preset of elements.presets) {
      preset.classList.remove('is-selected');
      preset.setAttribute('aria-pressed', 'false');
    }
  }

  for (const preset of elements.presets) {
    preset.addEventListener('click', () => {
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
      elements.amount.value = preset.dataset.amount;
      updateCurrencyConfiguration();
      previewRoute();
    });
  }

  elements.currency.addEventListener('change', () => {
    selectManualScenario();
    updateCurrencyConfiguration({ resetAmount: true });
    previewRoute();
  });

  elements.paymentType.addEventListener('change', () => {
    selectManualScenario();
    previewRoute();
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (freshPreviewRequired) {
      setCheckoutStatus(
        'Start a fresh route preview before attempting another payment.',
        'blocked'
      );
      return;
    }

    if (!form.reportValidity() || !hostedFieldsInstance || paymentRunning) {
      if (!hostedFieldsInstance) {
        setCheckoutStatus('Wait for the secure card fields and complete the card details.', 'blocked');
      }
      return;
    }

    paymentRunning = true;
    previewGeneration += 1;
    const submittedIntent = currentIntent();
    elements.runButton.disabled = true;
    setIntentControlsDisabled(true);
    setInspectorState('Processing', 'waiting');
    setCheckoutStatus('Tokenizing the card and sending the routed sandbox payment…');
    let saleRequestStarted = false;

    try {
      const paymentMethod = await hostedFieldsInstance.tokenize();
      saleRequestStarted = true;
      const response = await postJson('/api/demo/payments/one-time', {
        ...submittedIntent,
        paymentMethodNonce: paymentMethod.nonce,
      });

      if (isCatalogUnavailable(response.data)) {
        renderCatalogUnavailable(response.data);
        return;
      }

      const outcomeUncertain =
        !response.readable ||
        (response.status >= 500 &&
          response.data?.error?.code !== 'AUDIT_PERSISTENCE_FAILED');
      renderPaymentResult(response.data, response.ok, outcomeUncertain);
    } catch (error) {
      if (saleRequestStarted) {
        freshPreviewRequired = true;
        setInspectorState('Outcome unknown', 'blocked');
        setCheckoutStatus(
          'The payment request was sent, but its result could not be confirmed. Do not retry; check the Sandbox Control Panel, then start a fresh route preview.',
          'blocked'
        );
        return;
      }

      setInspectorState('Not completed', 'blocked');
      const invalidFields = Array.isArray(error?.details?.invalidFieldKeys)
        ? error.details.invalidFieldKeys
            .map((field) => ({
              number: 'card number',
              expirationDate: 'expiry date',
              cvv: 'security code',
            })[field] || field)
        : [];
      setCheckoutStatus(
        invalidFields.length > 0
          ? `Check the ${invalidFields.join(', ')} and try again.`
          : 'The payment could not be completed. Check the sandbox card fields and try again.',
        'blocked'
      );
    } finally {
      paymentRunning = false;
      setIntentControlsDisabled(catalogUnavailable);
      elements.runButton.disabled =
        catalogUnavailable || !hostedFieldsInstance || freshPreviewRequired;
    }
  });

  for (const button of elements.refreshButtons) {
    button.addEventListener('click', refreshCatalog);
  }

  updateCurrencyConfiguration();
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
