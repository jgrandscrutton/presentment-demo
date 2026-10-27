(() => {
  'use strict';

  const entries = [...document.querySelectorAll(
    '.transaction-log-entry[data-operable="true"]'
  )];

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
