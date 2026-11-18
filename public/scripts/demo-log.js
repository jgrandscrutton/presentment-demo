(() => {
  'use strict';

  const entries = [...document.querySelectorAll(
    '.transaction-log-entry[data-operable="true"]'
  )];
  const resetPanel = document.querySelector('[data-local-reset]');
  const resetButton = document.querySelector('[data-local-reset-button]');
  const resetStatus = document.querySelector('#local-reset-status');
  const RESET_CONFIRMATION_HEADER = 'X-Demo-Reset-Confirmation';
  const RESET_SCOPE = 'local_event_store';
  const RESET_NOTICE_KEY = 'phonepal.localResetNotice';

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let payload;
    let readable = true;
    try {
      payload = await response.json();
    } catch {
      readable = false;
      payload = {
        success: false,
        error: { message: 'The server returned an unreadable response.' },
      };
    }
    return { response, payload, readable };
  }

  function setStatus(entry, message, state = '') {
    const status = entry.querySelector('[data-live-status]');
    if (!status) return;
    status.textContent = message;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  function setBusy(entry, busy) {
    for (const button of entry.querySelectorAll('[data-operation]')) {
      button.disabled = busy;
    }
  }

  function renderActions(entry, payload) {
    const controls = entry.querySelector('[data-action-controls]');
    const noActions = entry.querySelector('[data-no-actions]');
    if (!controls) return;

    let allowedCount = 0;
    for (const action of ['capture', 'void', 'settle', 'refund']) {
      const state = payload.actions?.[action];
      const group = entry.querySelector(`[data-action-group="${action}"]`);
      if (!group) continue;
      const allowed = state?.allowed === true;
      group.hidden = !allowed;
      if (!allowed) continue;
      allowedCount += 1;

      const input = entry.querySelector(`[data-action-amount="${action}"]`);
      const maximumCopy = entry.querySelector(`[data-maximum-copy="${action}"]`);
      if (input && state.maximumAmount) {
        input.placeholder = `Up to ${state.maximumAmount}`;
        input.dataset.maximumAmount = state.maximumAmount;
      }
      if (maximumCopy && state.maximumAmount) {
        maximumCopy.textContent = `Maximum now: ${state.maximumAmount} ${payload.transaction?.currencyIsoCode || ''}`;
      }
    }

    controls.hidden = allowedCount === 0;
    if (noActions) noActions.hidden = allowedCount !== 0;
    setStatus(
      entry,
      `Live status: ${payload.transaction?.status || 'unknown'} · ${allowedCount} action${allowedCount === 1 ? '' : 's'} available`,
      allowedCount > 0 ? 'success' : ''
    );
  }

  async function refreshEntry(entry) {
    const eventId = entry.dataset.eventId;
    if (!eventId) return;
    setBusy(entry, true);
    setStatus(entry, 'Checking live Braintree status…');
    try {
      const { response, payload, readable } = await requestJson(
        `/api/demo/transactions/${encodeURIComponent(eventId)}/status`
      );
      if (!readable || !response.ok || payload.success !== true) {
        throw new Error(
          payload.error?.message || 'Live transaction status could not be loaded.'
        );
      }
      renderActions(entry, payload);
      entry.dataset.liveStatusLoaded = 'true';
    } catch (error) {
      const controls = entry.querySelector('[data-action-controls]');
      if (controls) controls.hidden = true;
      setStatus(entry, error.message, 'error');
    } finally {
      setBusy(entry, false);
    }
  }

  async function performAction(entry, button) {
    const eventId = entry.dataset.eventId;
    const action = button.dataset.operation;
    if (!eventId || !action) return;

    const amountSource = button.dataset.amountSource;
    const input = amountSource
      ? entry.querySelector(`[data-action-amount="${amountSource}"]`)
      : null;
    const amount = input?.value?.trim() || '';
    if (amountSource && !amount) {
      setStatus(entry, `Enter a ${action} amount first.`, 'error');
      input?.focus();
      return;
    }

    setBusy(entry, true);
    setStatus(entry, `Requesting ${action}…`);
    try {
      const { response, payload, readable } = await requestJson(
        `/api/demo/transactions/${encodeURIComponent(eventId)}/actions/${encodeURIComponent(action)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(amount ? { amount } : {}),
        }
      );
      if (!readable) {
        const controls = entry.querySelector('[data-action-controls]');
        if (controls) controls.hidden = true;
        setStatus(
          entry,
          'The action response was unreadable, so its outcome is unknown. Do not retry; inspect the Sandbox Control Panel first.',
          'error'
        );
        return;
      }
      if (!response.ok || payload.success !== true) {
        const message = payload.error?.message || `Braintree did not complete ${action}.`;
        if (payload.retrySafe === false || /do not retry/i.test(message)) {
          const controls = entry.querySelector('[data-action-controls]');
          if (controls) controls.hidden = true;
          setStatus(entry, message, 'error');
          // Keep every action disabled: the gateway outcome may be ambiguous,
          // so a presenter must inspect the Control Panel before continuing.
          return;
        }
        setStatus(entry, message, 'error');
        setBusy(entry, false);
        return;
      }

      const warning = payload.audit?.persisted === false
        ? ` ${payload.audit.warning || 'The local audit could not be saved; do not retry.'}`
        : '';
      setStatus(entry, `${action} succeeded.${warning}`, warning ? 'error' : 'success');
      if (warning) return;
      window.location.reload();
    } catch (error) {
      const controls = entry.querySelector('[data-action-controls]');
      if (controls) controls.hidden = true;
      setStatus(
        entry,
        'The connection ended before the action result was confirmed. Do not retry; inspect the Sandbox Control Panel first.',
        'error'
      );
    }
  }

  function setResetStatus(message, state = '') {
    if (!resetStatus) return;
    resetStatus.textContent = message;
    if (state) resetStatus.dataset.state = state;
    else delete resetStatus.dataset.state;
  }

  try {
    const resetNotice = window.sessionStorage?.getItem(RESET_NOTICE_KEY);
    if (resetNotice) {
      window.sessionStorage.removeItem(RESET_NOTICE_KEY);
      setResetStatus(resetNotice, 'success');
    }
  } catch {
    // Storage can be disabled; the pre-reload live message remains available.
  }

  async function resetLocalDemo() {
    if (!resetButton || !resetPanel) return;
    const confirmation = resetButton.dataset.resetConfirmation;
    const endpoint = resetButton.dataset.resetEndpoint;
    if (!confirmation || !endpoint) {
      setResetStatus('Local reset is unavailable. Nothing changed.', 'error');
      return;
    }

    const confirmed = typeof window.confirm === 'function' && window.confirm(
      'Reset only this demo’s local audit history? This clears the visible event trail. It does not delete or change any Braintree transactions, subscriptions, customers, payment methods, or disputes.'
    );
    if (!confirmed) {
      setResetStatus('Reset cancelled. Nothing changed.', 'neutral');
      return;
    }

    resetButton.disabled = true;
    resetPanel.setAttribute('aria-busy', 'true');
    setResetStatus('Clearing local demo history…', 'busy');
    try {
      const { response, payload, readable } = await requestJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [RESET_CONFIRMATION_HEADER]: confirmation,
        },
        body: JSON.stringify({ scope: RESET_SCOPE }),
      });
      if (!readable || !response.ok || payload.success !== true) {
        const resetError = new Error(
          readable && payload.error?.message
            ? payload.error.message
            : 'Local demo history could not be cleared. Nothing in Braintree was changed.'
        );
        resetError.safeResetMessage = true;
        throw resetError;
      }

      const cleared = Number.isInteger(payload.clearedLocalEvents)
        ? payload.clearedLocalEvents
        : 0;
      const successMessage =
        `${cleared} local ${cleared === 1 ? 'event' : 'events'} cleared. Braintree objects are unchanged.`;
      setResetStatus(`${successMessage} Reloading…`, 'success');
      try {
        window.sessionStorage?.setItem(RESET_NOTICE_KEY, successMessage);
      } catch {
        // The current aria-live message still names the completed boundary.
      }
      resetPanel.removeAttribute('aria-busy');
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(() => window.location.reload(), 800);
      } else {
        window.location.reload();
      }
    } catch (error) {
      resetPanel.removeAttribute('aria-busy');
      resetButton.disabled = false;
      setResetStatus(
        error?.safeResetMessage
          ? error.message
          : 'Local demo history could not be cleared. Nothing in Braintree was changed.',
        'error'
      );
    }
  }

  resetButton?.addEventListener('click', resetLocalDemo);

  for (const entry of entries) {
    for (const button of entry.querySelectorAll('[data-operation]')) {
      button.disabled = true;
      button.addEventListener('click', () => performAction(entry, button));
    }
    entry.addEventListener('toggle', () => {
      if (entry.open && entry.dataset.liveStatusLoaded !== 'true') {
        refreshEntry(entry);
      }
    });
    if (entry.open) refreshEntry(entry);
  }
})();
