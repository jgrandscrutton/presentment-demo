(function () {
  const root = document.querySelector('[data-billing-dashboard]');
  if (!root) return;
  const feedback = root.querySelector('[data-billing-feedback]');
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  async function request(path, body) {
    const response = await fetch('/api/billing' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update billing.');
    return result;
  }
  function button(label, action, className = 'btn btn-outline') {
    const node = element('button', label, className); node.type = 'button';
    node.onclick = async () => {
      node.disabled = true; feedback.textContent = '';
      try { await action(); await load(); }
      catch (error) { feedback.textContent = error.message; }
      finally { node.disabled = false; }
    };
    return node;
  }
  async function load() {
    const data = await request('');
    const plans = root.querySelector('[data-agreements]'); plans.replaceChildren();
    for (const plan of data.agreements) {
      const card = element('article', undefined, 'billing-card');
      const header = element('div', undefined, 'billing-card-header');
      header.append(element('h3', plan.name), element('span', plan.status.replaceAll('_', ' '), 'billing-status'));
      card.append(header, element('p', plan.type === 'recurring' ? `Usage billed ${plan.frequency}, up to £${plan.amount}. Current usage: £${plan.accrued}.` : plan.type === 'unscheduled' ? `Prepaid balance: £${plan.balance}. Automatic top-up: £${plan.amount}.` : `£${plan.amount} ${plan.frequency}.`));
      if (plan.nextDue && !['cancelled', 'completed'].includes(plan.status)) card.append(element('p', `Next billing date: ${new Date(plan.nextDue).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}`));
      if (plan.lastError) card.append(element('p', plan.lastError, 'payment-feedback'));
      const actions = element('div', undefined, 'billing-actions');
      if (!['cancelled', 'completed', 'cancel_pending'].includes(plan.status)) {
        actions.append(button('Cancel future payments', () => request(`/agreements/${encodeURIComponent(plan.id)}/cancel`, {})));
        if (data.methods.length > 1) {
          const select = element('select', undefined, 'form-input'); select.setAttribute('aria-label', 'Plan payment method');
          for (const method of data.methods) { const option = element('option', method.label); option.value = method.id; option.selected = plan.methodId === method.id; select.appendChild(option); }
          actions.append(select, button('Change payment method', () => request(`/agreements/${encodeURIComponent(plan.id)}/payment-method`, { methodId: select.value })));
        }
      }
      if (plan.status === 'past_due') actions.append(button('Retry declined payment', () => request(`/agreements/${encodeURIComponent(plan.id)}/retry`, {})));
      card.appendChild(actions);
      if (['recurring', 'unscheduled'].includes(plan.type) && plan.status === 'active') {
        const form = element('form', undefined, 'billing-usage-form');
        const heading = element('h4', 'Record sandbox usage'); form.append(heading, element('p', 'Calls: 3p/min · texts: 2p each · data: 1p/MB', 'payment-demo-note'));
        for (const [name, label] of [['minutes', 'Call minutes'], ['texts', 'Texts'], ['dataMB', 'Data (MB)']]) {
          const wrapper = element('label', label, 'form-label'); const input = element('input', undefined, 'form-input'); input.name = name; input.type = 'number'; input.min = '0'; input.max = '100000'; input.value = '0'; wrapper.append(input); form.append(wrapper);
        }
        const submit = element('button', 'Record usage', 'btn btn-primary'); submit.type = 'submit'; form.append(submit);
        form.onsubmit = async event => {
          event.preventDefault(); submit.disabled = true; feedback.textContent = '';
          form.dataset.eventId ||= crypto.randomUUID();
          try { await request(`/agreements/${encodeURIComponent(plan.id)}/usage`, { ...Object.fromEntries(new FormData(form)), eventId: form.dataset.eventId }); await load(); }
          catch (error) { feedback.textContent = error.message; submit.disabled = false; }
        };
        card.append(form);
      }
      plans.append(card);
    }
    if (!data.agreements.length) plans.append(element('p', 'You have no billing plans yet.', 'payment-demo-note'));
    const methods = root.querySelector('[data-methods]'); methods.replaceChildren();
    for (const method of data.methods) {
      const row = element('div', undefined, 'billing-card billing-card-header');
      row.append(element('span', method.label), button('Remove', () => request(`/payment-methods/${encodeURIComponent(method.id)}/remove`, {}))); methods.append(row);
    }
    if (!data.methods.length) methods.append(element('p', 'Payment methods saved during checkout appear here.', 'payment-demo-note'));
    const history = root.querySelector('[data-payments]'); history.replaceChildren();
    if (!data.payments.length) history.append(element('p', 'No payments yet.', 'payment-demo-note'));
    else {
      const wrapper = element('div', undefined, 'billing-table-wrap'); const table = element('table', undefined, 'billing-table');
      const head = element('tr'); for (const label of ['Date', 'Description', 'Amount', 'Status', 'Reference']) head.append(element('th', label)); table.append(head);
      for (const payment of data.payments) {
        const row = element('tr'); for (const text of [new Date(payment.createdAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }), payment.description, `£${payment.amount}`, payment.status.replaceAll('_', ' '), payment.id]) row.append(element('td', text)); table.append(row);
      }
      wrapper.append(table); history.append(wrapper);
    }
    feedback.textContent = '';
  }
  load().catch(error => { feedback.textContent = error.message; });
})();
