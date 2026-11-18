(() => {
  'use strict';

  const list = document.getElementById('dispute-list');
  const empty = document.getElementById('empty-disputes');
  const pollingStatus = document.getElementById('polling-status');
  if (!list || !empty || !pollingStatus) return;

  let refreshInProgress = false;
  const actionsInProgress = new Set();
  const liveStatusCache = new Map();
  const LIVE_STATUS_TTL_MS = 30000;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function readableDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || 'Unknown time';
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/London',
    }).format(date);
  }

  function readableAmount(amount, currency) {
    if (amount == null || !currency) return 'Not reported';
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency,
      }).format(numeric);
    } catch {
      return `${amount} ${currency}`;
    }
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = {
        success: false,
        error: { message: 'The server returned an unreadable response.' },
      };
    }
    return { response, payload };
  }

  function detail(label, value) {
    const wrapper = node('div');
    wrapper.append(node('dt', '', label), node('dd', '', value || '—'));
    return wrapper;
  }

  function setCardStatus(card, message, state = '') {
    const status = card.querySelector('[data-action-status]');
    if (!status) return;
    status.textContent = message;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  function setCardBusy(card, busy) {
    for (const control of card.querySelectorAll('button, textarea')) {
      control.disabled = busy;
    }
  }

  function applyActionState(card, payload) {
    const actions = payload.actions || {};
    const status = payload.dispute?.status || actions.status || 'unknown';
    const statusBadge = card.querySelector('[data-dispute-status]');
    if (statusBadge) {
      statusBadge.textContent = status;
      statusBadge.dataset.status = status;
    }

    for (const action of ['accept', 'evidence', 'finalize']) {
      const allowed = actions[action]?.allowed === true;
      const controls = card.querySelectorAll(`[data-dispute-action="${action}"]`);
      for (const control of controls) control.disabled = !allowed;
    }

    const available = ['accept', 'evidence', 'finalize'].some(
      (action) => actions[action]?.allowed === true
    );
    setCardStatus(
      card,
      available
        ? `Live status: ${status}. Actions are available for this open dispute.`
        : `Live status: ${status}. This dispute is read-only.`,
      available ? 'success' : ''
    );
  }

  async function refreshCardStatus(card, { force = false } = {}) {
    const eventId = card.dataset.eventId;
    if (!eventId || card.dataset.linked !== 'true') return;
    const cached = liveStatusCache.get(eventId);
    if (!force && cached && Date.now() - cached.checkedAt < LIVE_STATUS_TTL_MS) {
      applyActionState(card, cached.payload);
      return;
    }
    setCardBusy(card, true);
    setCardStatus(card, 'Checking live Braintree dispute status…');
    try {
      const { response, payload } = await requestJson(
        `/demo/disputes/${encodeURIComponent(eventId)}/status`
      );
      if (!response.ok || payload.success !== true) {
        throw new Error(payload.error?.message || 'Live dispute status could not be loaded.');
      }
      liveStatusCache.set(eventId, { checkedAt: Date.now(), payload });
      applyActionState(card, payload);
    } catch (error) {
      setCardStatus(card, error.message, 'error');
    }
  }

  async function performAction(card, action) {
    const eventId = card.dataset.eventId;
    if (!eventId || actionsInProgress.has(eventId)) return;

    let body;
    if (action === 'accept') {
      if (!window.confirm('Accept this dispute? This concedes the disputed amount and cannot be undone.')) return;
      body = { confirm: true };
    } else if (action === 'finalize') {
      if (!window.confirm('Finalize this dispute? Braintree will submit the added evidence to the bank.')) return;
      body = { confirm: true };
    } else {
      const evidence = card.querySelector('[data-evidence-input]')?.value?.trim() || '';
      if (!evidence) {
        setCardStatus(card, 'Enter text evidence before submitting.', 'error');
        card.querySelector('[data-evidence-input]')?.focus();
        return;
      }
      body = { evidence };
    }

    actionsInProgress.add(eventId);
    liveStatusCache.delete(eventId);
    setCardBusy(card, true);
    setCardStatus(card, `Requesting ${action}…`);
    try {
      const { response, payload } = await requestJson(
        `/demo/disputes/${encodeURIComponent(eventId)}/actions/${encodeURIComponent(action)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok || payload.success !== true) {
        const message = payload.error?.message || `Braintree did not complete ${action}.`;
        setCardStatus(card, message, 'error');
        if (payload.retrySafe === false) return;
        await refreshCardStatus(card, { force: true });
        return;
      }

      if (action === 'evidence') {
        const input = card.querySelector('[data-evidence-input]');
        if (input) input.value = '';
      }
      const warning = payload.audit?.persisted === false
        ? ` ${payload.audit.warning || 'The local audit could not be saved; do not retry.'}`
        : '';
      setCardStatus(card, `${action} succeeded.${warning}`, warning ? 'error' : 'success');
      liveStatusCache.set(eventId, { checkedAt: Date.now(), payload });
      if (!warning) applyActionState(card, payload);
    } catch {
      setCardStatus(
        card,
        'The connection ended before the action was confirmed. Do not retry; inspect the Sandbox Control Panel first.',
        'error'
      );
    } finally {
      actionsInProgress.delete(eventId);
    }
  }

  function buildCard(dispute) {
    const card = node('article', 'dispute-card');
    card.dataset.eventId = dispute.eventId;
    card.dataset.linked = String(dispute.linked === true);

    const header = node('div', 'dispute-card-header');
    const title = node('div');
    title.append(
      node('p', 'dispute-kicker', readableDate(dispute.receivedAt)),
      node('h3', '', `Dispute ${dispute.disputeId}`),
      node('p', 'dispute-meta', dispute.disputeReason || dispute.webhookKind || 'Reason not reported')
    );
    const badge = node('span', 'dispute-status', dispute.disputeStatus || 'unknown');
    badge.dataset.disputeStatus = '';
    badge.dataset.status = dispute.disputeStatus || 'unknown';
    header.append(title, badge);

    const details = node('dl', 'dispute-details');
    details.append(
      detail('Amount', readableAmount(dispute.amount, dispute.currency)),
      detail('Transaction', dispute.transactionId || 'Not linked'),
      detail('Merchant account', dispute.merchantAccountId || 'Not linked'),
      detail('Webhook', dispute.webhookKind || 'Dispute event')
    );
    card.append(header, details);

    const actions = node('div', 'dispute-actions');
    const status = node(
      'p',
      'action-status',
      dispute.linked
        ? 'Checking live Braintree dispute status…'
        : 'This webhook is not linked to a verified local transaction and is read-only.'
    );
    status.dataset.actionStatus = '';
    actions.append(status);

    const buttons = node('div', 'action-buttons');
    const accept = node('button', 'danger', 'Accept dispute');
    accept.type = 'button';
    accept.disabled = true;
    accept.dataset.disputeAction = 'accept';
    accept.addEventListener('click', () => performAction(card, 'accept'));
    const finalize = node('button', 'secondary', 'Finalize evidence');
    finalize.type = 'button';
    finalize.disabled = true;
    finalize.dataset.disputeAction = 'finalize';
    finalize.addEventListener('click', () => performAction(card, 'finalize'));
    buttons.append(accept, finalize);

    const evidenceForm = node('div', 'evidence-form');
    const evidenceId = `evidence-${String(dispute.eventId).replace(/[^A-Za-z0-9_-]/g, '')}`;
    const evidenceLabel = node('label', '', 'Text evidence');
    evidenceLabel.htmlFor = evidenceId;
    const textarea = node('textarea');
    textarea.id = evidenceId;
    textarea.maxLength = 4000;
    textarea.placeholder = 'Sandbox examples: compelling_evidence or losing_evidence';
    textarea.disabled = true;
    textarea.dataset.evidenceInput = '';
    textarea.dataset.disputeAction = 'evidence';
    const submitEvidence = node('button', '', 'Add text evidence');
    submitEvidence.type = 'button';
    submitEvidence.disabled = true;
    submitEvidence.dataset.disputeAction = 'evidence';
    submitEvidence.addEventListener('click', () => performAction(card, 'evidence'));
    evidenceForm.append(evidenceLabel, textarea, submitEvidence);
    actions.append(buttons, evidenceForm);
    card.append(actions);

    return card;
  }

  async function refreshActivity() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const { response, payload } = await requestJson('/api/webhooks/activity');
      if (!response.ok || payload.success !== true || !Array.isArray(payload.disputes)) {
        throw new Error(payload.error?.message || 'Dispute activity could not be loaded.');
      }

      if (actionsInProgress.size > 0) {
        pollingStatus.textContent = 'A webhook check completed; rendering is paused while a dispute action is in progress.';
        return;
      }

      // Do not destroy a presenter's draft or move their focus during polling.
      // The latest activity is rendered on the first poll after the textarea
      // loses focus.
      const draftEvidence = document.activeElement;
      if (
        draftEvidence instanceof HTMLTextAreaElement &&
        list.contains(draftEvidence) &&
        draftEvidence.matches('[data-evidence-input]')
      ) {
        pollingStatus.textContent = 'A webhook check completed; rendering is paused while evidence is being edited.';
        return;
      }

      list.replaceChildren();
      empty.hidden = payload.disputes.length !== 0;
      const visibleEventIds = new Set(payload.disputes.map((dispute) => dispute.eventId));
      for (const eventId of liveStatusCache.keys()) {
        if (!visibleEventIds.has(eventId)) liveStatusCache.delete(eventId);
      }
      for (const dispute of payload.disputes) {
        const card = buildCard(dispute);
        list.append(card);
        if (dispute.linked) refreshCardStatus(card);
      }
      pollingStatus.textContent = payload.disputes.length === 0
        ? 'Listening for verified Braintree dispute webhooks…'
        : `${payload.disputes.length} dispute event${payload.disputes.length === 1 ? '' : 's'} · checked ${new Date().toLocaleTimeString('en-GB')}`;
    } catch (error) {
      pollingStatus.textContent = error.message;
    } finally {
      list.setAttribute('aria-busy', 'false');
      refreshInProgress = false;
    }
  }

  refreshActivity();
  window.setInterval(refreshActivity, 5000);
})();
