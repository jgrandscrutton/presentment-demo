(async function () {
  const container = document.querySelector('[data-storefront-payment]');
  const messageElements = [...document.querySelectorAll('[data-paylater-message]')];
  if (!container && !messageElements.length) return;
  const feedback = container?.querySelector('[data-payment-feedback]') || document.createElement('p');
  const cardFeedback = container?.querySelector('[data-card-feedback]');
  const cardButton = container?.querySelector('[data-card-submit]');
  const demoForm = container?.querySelector('[data-demo-billing]');
  const recurring = ['plan', 'demo'].includes(container?.dataset.kind);
  const consent = container?.querySelector('[data-billing-consent]');
  const walletActions = [];
  let activeQuote, client, tokenData, quoteWork = Promise.resolve(), quoteVersion = 0;
  let busy = false, cardReady = false, quoteReady = false, threeDSecurePromise;

  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'This payment option is unavailable. Please try again.');
    return result;
  }
  function updateControls() {
    const blocked = busy || !quoteReady || (recurring && !consent?.checked);
    if (cardButton) cardButton.disabled = blocked || !cardReady;
    container?.querySelectorAll('[data-wallet-action]').forEach(button => {
      button.disabled = blocked;
      button.setAttribute('aria-disabled', String(blocked));
      button.style.pointerEvents = blocked ? 'none' : '';
    });
    for (const actions of walletActions) blocked ? actions.disable() : actions.enable();
  }
  function freeze(value) {
    busy = value;
    document.querySelectorAll('.storage-pill, .colour-pill, .contract-pill, .topup-pill, .threshold-pill, #add-to-basket, [data-demo-billing] input, [data-demo-billing] select, [data-monthly-limit]').forEach(input => { input.disabled = value; });
    if (!value && demoForm) toggleDemoFields();
    if (consent) consent.disabled = value;
    updateControls();
  }
  function canStart() {
    if (busy || !quoteReady) { feedback.textContent = 'Wait for the payment details to finish updating.'; return false; }
    if (recurring && !consent?.checked) { feedback.textContent = 'Confirm the billing terms before continuing.'; consent?.focus(); return false; }
    if (demoForm && !demoForm.reportValidity()) return false;
    const email = container?.querySelector('[data-billing-email]');
    return !email || email.reportValidity();
  }
  function selection() {
    return {
      ...(demoForm ? Object.fromEntries(new FormData(demoForm)) : {}),
      kind: container.dataset.kind,
      deviceId: container.dataset.deviceId,
      storageIndex: Number(document.querySelector('.storage-pill.active')?.dataset.storageIndex || 0),
      colour: document.querySelector('.colour-pill.active')?.dataset.colour,
      planId: container.dataset.planId,
      contractLengthId: document.querySelector('.contract-pill.active')?.dataset.contractId,
      topUpAmount: document.querySelector('.topup-pill.active')?.dataset.amount,
      threshold: document.querySelector('.threshold-pill.active')?.dataset.threshold,
      monthlyLimit: document.querySelector('[data-monthly-limit]')?.value,
    };
  }
  function toggleDemoFields() {
    const type = demoForm.elements.type.value;
    demoForm.querySelectorAll('[data-for-types]').forEach(section => {
      section.hidden = !section.dataset.forTypes.split(' ').includes(type);
      section.querySelectorAll('input,select').forEach(input => { input.disabled = section.hidden; });
    });
  }
  function refreshQuote() {
    const version = ++quoteVersion;
    quoteReady = false;
    if (consent) consent.checked = false;
    updateControls();
    quoteWork = quoteWork.catch(() => {}).then(async () => {
      if (version !== quoteVersion) return;
      try {
        const prepared = await request('/api/storefront/quote', selection());
        if (version !== quoteVersion) return;
        activeQuote = prepared;
        quoteReady = true;
        const terms = container.querySelector('[data-billing-terms]');
        if (terms) terms.textContent = prepared.consentText;
        feedback.textContent = '';
      } catch (error) { if (version === quoteVersion) feedback.textContent = error.message; }
      updateControls();
    });
    return quoteWork;
  }
  async function complete(nonce, options = {}) {
    feedback.textContent = 'Processing securely…';
    const result = await request('/api/storefront/pay', {
      quoteId: activeQuote.id, nonce, savedMethodId: options.savedMethodId,
      billingConsent: consent?.checked === true,
      savePaymentMethod: options.savePaymentMethod === true,
      email: container.querySelector('[data-billing-email]')?.value || undefined,
    });
    if (options.redirect !== false) window.location.assign(result.redirect);
    return result;
  }
  function getThreeDSecure() {
    threeDSecurePromise ||= braintree.threeDSecure.create({ client, version: 2 });
    return threeDSecurePromise;
  }
  async function authenticate(payload) {
    const threeDSecure = await getThreeDSecure();
    const verified = await threeDSecure.verifyCard({
      amount: activeQuote.amount, nonce: payload.nonce, bin: payload.details?.bin || payload.bin,
      email: container.querySelector('[data-billing-email]')?.value || activeQuote.email,
      billingAddress: activeQuote.billingAddress, onLookupComplete: (_data, next) => next(),
    });
    if (!(verified.liabilityShifted ?? verified.threeDSecureInfo?.liabilityShifted)) throw new Error('Card authentication was not completed. Please try again.');
    return verified.nonce;
  }
  async function renderMessages() {
    if (typeof paypal.Messages !== 'function') return;
    const instances = new Map();
    for (const element of messageElements) {
      const amount = element.dataset.paylaterAmount;
      const placement = element.dataset.paylaterPlacement || (container?.dataset.kind === 'cart' ? 'cart' : amount ? 'product' : 'home');
      try {
        const message = paypal.Messages({ ...(amount ? { amount: Number(amount) } : {}), placement, style: element.dataset.paylaterLayout === 'flex' || element.dataset.ppStyleLayout === 'flex' ? { layout: 'flex', ratio: '20x1', color: 'blue' } : { layout: 'text', logo: { type: 'primary' }, text: { color: 'black' } } });
        await message.render(element);
        instances.set(element, message);
      } catch { element.hidden = true; }
    }
    new MutationObserver(records => {
      for (const record of records) {
        const instance = instances.get(record.target);
        if (instance) Promise.resolve(instance.update({ amount: Number(record.target.dataset.paylaterAmount) })).catch(() => {});
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-paylater-amount'] });
  }
  async function setupWallet() {
    const wallet = await braintree.paypalCheckout.create({ client });
    await wallet.loadPayPalSDK(recurring ? { vault: true, intent: 'tokenize', locale: 'en_GB' } : { currency: 'GBP', intent: 'capture', components: 'buttons,messages', locale: 'en_GB', 'enable-funding': 'paylater' });
    if (!recurring) renderMessages().catch(() => {});
    const root = container?.querySelector('[data-paypal-buttons]');
    if (!root) return;
    const sources = recurring ? [paypal.FUNDING.PAYPAL] : [paypal.FUNDING.PAYPAL, paypal.FUNDING.PAYLATER];
    for (const source of sources) {
      const buttons = paypal.Buttons({
        fundingSource: source,
        onInit: (_data, actions) => { walletActions.push(actions); updateControls(); },
        onClick: (_data, actions) => canStart() ? actions.resolve() : actions.reject(),
        style: { layout: 'vertical', shape: 'pill', label: 'pay' },
        [recurring ? 'createBillingAgreement' : 'createOrder']: async () => {
          if (!canStart()) throw new Error('Review the checkout details.');
          freeze(true);
          try { return await wallet.createPayment(activeQuote.paymentOptions); }
          catch (error) { freeze(false); feedback.textContent = error.message; throw error; }
        },
        onApprove: async data => {
          try { const payload = await wallet.tokenizePayment(data); await complete(payload.nonce); }
          catch (error) { feedback.textContent = error.message; freeze(false); }
        },
        onCancel: () => { feedback.textContent = 'Payment cancelled. You can continue when ready.'; freeze(false); },
        onError: () => { feedback.textContent = 'PayPal could not complete checkout. Check Billing before retrying.'; freeze(false); },
      });
      if (buttons.isEligible()) { const target = document.createElement('div'); root.appendChild(target); await buttons.render(target); }
    }
    updateControls();
  }
  async function setupCards() {
    const form = container?.querySelector('[data-card-form]');
    if (!form) return;
    form.addEventListener('submit', event => event.preventDefault());
    const [fields] = await Promise.all([
      braintree.hostedFields.create({ client,
        styles: { input: { 'font-size': '16px', 'font-family': 'system-ui, sans-serif', color: '#2C2E2F' }, ':focus': { color: '#2E2DA8' }, '.invalid': { color: '#b42318' } },
        fields: { number: { container: '#card-number', placeholder: 'Card number' }, expirationDate: { container: '#card-expiry', placeholder: 'MM / YY' }, cvv: { container: '#card-cvv', placeholder: 'CVV' } },
      }), getThreeDSecure(),
    ]);
    cardReady = true;
    updateControls();
    form.addEventListener('submit', async () => {
      if (!canStart()) return;
      freeze(true);
      try { cardFeedback.textContent = 'Authenticating your card…'; const nonce = await authenticate(await fields.tokenize()); await complete(nonce, { savePaymentMethod: container.querySelector('[data-save-card]')?.checked }); }
      catch (error) { cardFeedback.textContent = error.message; feedback.textContent = ''; freeze(false); }
    });
  }
  async function setupSavedMethods() {
    const root = container?.querySelector('[data-saved-methods]');
    if (!root) return;
    const { methods } = await request('/api/billing');
    if (!methods.length) return;
    const select = document.createElement('select'); select.className = 'form-input'; select.setAttribute('aria-label', 'Saved payment method');
    for (const method of methods) { const option = document.createElement('option'); option.value = method.id; option.textContent = method.label; select.appendChild(option); }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline'; button.dataset.walletAction = ''; button.textContent = 'Use saved payment method';
    button.onclick = async () => {
      if (!canStart()) return;
      freeze(true);
      try {
        const saved = await request(`/api/billing/payment-methods/${encodeURIComponent(select.value)}/nonce`, {});
        if (saved.savedMethodId) await complete(undefined, { savedMethodId: saved.savedMethodId });
        else await complete(await authenticate(saved));
      } catch (error) { feedback.textContent = error.message; freeze(false); }
    };
    root.append(select, button); updateControls();
  }
  async function setupApplePay() {
    const root = container?.querySelector('[data-express-wallets]');
    if (!root || !window.ApplePaySession || location.protocol !== 'https:' || !ApplePaySession.canMakePayments()) return false;
    const apple = await braintree.applePay.create({ client });
    const button = document.createElement('button'); button.type = 'button'; button.className = 'apple-pay-button'; button.dataset.walletAction = ''; button.setAttribute('aria-label', 'Buy with Apple Pay'); button.textContent = 'Apple Pay';
    button.onclick = () => {
      if (!canStart()) return;
      freeze(true);
      let session;
      try { session = new ApplePaySession(3, apple.createPaymentRequest({ countryCode: 'GB', currencyCode: 'GBP', total: { label: 'Merchant & Co.', amount: activeQuote.amount } })); }
      catch { feedback.textContent = 'Apple Pay could not start. Choose another payment option.'; freeze(false); return; }
      session.onvalidatemerchant = async event => {
        try { session.completeMerchantValidation(await apple.performValidation({ validationURL: event.validationURL, displayName: 'Merchant & Co.' })); }
        catch { feedback.textContent = 'Apple Pay could not validate this store. Use another payment method.'; session.abort(); freeze(false); }
      };
      session.onpaymentauthorized = async event => {
        try { const payload = await apple.tokenize({ token: event.payment.token }); const result = await complete(payload.nonce, { redirect: false }); session.completePayment(ApplePaySession.STATUS_SUCCESS); window.location.assign(result.redirect); }
        catch (error) { session.completePayment(ApplePaySession.STATUS_FAILURE); feedback.textContent = error.message; freeze(false); }
      };
      session.oncancel = () => freeze(false);
      try { session.begin(); } catch { feedback.textContent = 'Apple Pay could not start. Please use another payment method.'; freeze(false); }
    };
    root.appendChild(button); updateControls(); return true;
  }
  async function setupGooglePay() {
    const root = container?.querySelector('[data-express-wallets]');
    if (!root || !window.isSecureContext) return false;
    const googlePayment = await braintree.googlePayment.create({ client, googlePayVersion: 2, ...(tokenData.googleMerchantId ? { googleMerchantId: tokenData.googleMerchantId } : {}) });
    if (!window.google?.payments?.api) await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://pay.google.com/gp/p/js/pay.js'; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
    const payments = new google.payments.api.PaymentsClient({ environment: tokenData.environment });
    const paymentRequest = () => {
      const data = googlePayment.createPaymentDataRequest({ transactionInfo: { currencyCode: 'GBP', totalPriceStatus: 'FINAL', totalPrice: activeQuote?.amount || '0.01' }, emailRequired: true });
      data.allowedPaymentMethods = data.allowedPaymentMethods.filter(method => method.type === 'CARD');
      return data;
    };
    const initial = paymentRequest();
    const ready = await payments.isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: initial.allowedPaymentMethods });
    if (!ready.result) return false;
    const button = payments.createButton({ buttonColor: 'black', buttonType: 'pay', buttonSizeMode: 'fill', onClick: () => {
      if (!canStart()) return;
      freeze(true);
      payments.loadPaymentData(paymentRequest()).then(data => googlePayment.parseResponse(data)).then(async payload => {
        const nonce = payload.details?.isNetworkTokenized === true ? payload.nonce : await authenticate(payload);
        await complete(nonce);
      }).catch(error => { feedback.textContent = error.statusCode === 'CANCELED' ? 'Google Pay cancelled.' : error.message || 'Google Pay could not complete checkout.'; freeze(false); });
    } });
    button.dataset.walletAction = ''; root.appendChild(button); updateControls(); return true;
  }

  try {
    if (!window.braintree) throw new Error('Payment scripts could not load. Check your connection and refresh.');
    if (container) {
      if (demoForm) { demoForm.elements.type.value = container.dataset.initialType || 'subscription'; toggleDemoFields(); demoForm.addEventListener('submit', event => event.preventDefault()); demoForm.addEventListener('input', () => { toggleDemoFields(); refreshQuote(); }); }
      document.querySelectorAll('.storage-pill, .colour-pill, .contract-pill, .topup-pill, .threshold-pill').forEach(button => button.addEventListener('click', () => refreshQuote()));
      document.querySelector('[data-monthly-limit]')?.addEventListener('input', () => refreshQuote());
      consent?.addEventListener('change', () => { feedback.textContent = ''; updateControls(); });
      refreshQuote();
    }
    tokenData = await request('/api/storefront/client-token');
    client = await braintree.client.create({ authorization: tokenData.clientToken });
    const results = await Promise.allSettled([setupWallet(), setupCards(), setupSavedMethods(), setupApplePay(), setupGooglePay()]);
    if (results[0].status === 'rejected') feedback.textContent = 'PayPal checkout is unavailable. Refresh the page to try again.';
    if (results[1].status === 'rejected' && cardFeedback) cardFeedback.textContent = 'Card payments are currently unavailable. Choose another payment option.';
    const availability = container?.querySelector('[data-wallet-availability]');
    if (availability && !results[3].value && !results[4].value) availability.textContent = 'Apple Pay and Google Pay appear on supported devices when enabled for this store.';
  } catch (error) { feedback.textContent = error.message; if (cardFeedback) cardFeedback.textContent = 'Card payments are currently unavailable.'; freeze(false); }
})();
