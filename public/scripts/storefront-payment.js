(async function () {
  const container = document.querySelector('[data-storefront-payment], [data-storefront-messaging]');
  if (!container) return;
  const feedback = container.querySelector('[data-payment-feedback]') || document.createElement('p');
  const cardFeedback = container.querySelector('[data-card-feedback]');
  const cardButton = container.querySelector('[data-card-submit]');
  let activeQuote;
  let busy = false;
  let cardReady = false;
  const walletActions = [];

  function freeze(value) {
    busy = value;
    document.querySelectorAll('.storage-pill, .colour-pill, .contract-pill, .topup-pill, .threshold-pill, #add-to-basket').forEach(button => { button.disabled = value; });
    if (cardButton) cardButton.disabled = value || !cardReady;
    for (const actions of walletActions) value ? actions.disable() : actions.enable();
  }

  async function request(url, body) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Payment is unavailable. Please try again.');
    return result;
  }

  function selection() {
    return {
      kind: container.dataset.kind,
      deviceId: container.dataset.deviceId,
      storageIndex: Number(document.querySelector('.storage-pill.active')?.dataset.storageIndex || 0),
      colour: document.querySelector('.colour-pill.active')?.dataset.colour,
      planId: container.dataset.planId,
      contractLengthId: document.querySelector('.contract-pill.active')?.dataset.contractId,
      topUpAmount: document.querySelector('.topup-pill.active')?.dataset.amount,
      threshold: document.querySelector('.threshold-pill.active')?.dataset.threshold,
    };
  }

  async function prepare() {
    if (busy) throw new Error('A payment is already in progress.');
    freeze(true);
    feedback.textContent = 'Preparing your payment…';
    activeQuote = await request('/api/storefront/quote', selection());
    return activeQuote;
  }

  async function complete(nonce) {
    feedback.textContent = 'Processing your payment…';
    const result = await request('/api/storefront/pay', { nonce, quoteId: activeQuote.id });
    window.location.assign(result.redirect);
  }

  try {
    if (!window.braintree) throw new Error('Payment scripts could not load. Check your connection and refresh the page.');
    const { clientToken } = await request('/api/storefront/client-token');
    const client = await braintree.client.create({ authorization: clientToken });

    async function setupWallet() {
      const wallet = await braintree.paypalCheckout.create({ client });
      const vault = container.dataset.kind === 'plan';
      await wallet.loadPayPalSDK(vault ? { vault: true, intent: 'tokenize', locale: 'en_GB' } : { currency: 'GBP', intent: 'capture', components: 'buttons,messages', locale: 'en_GB', 'enable-funding': 'paylater' });
      const root = container.querySelector('[data-paypal-buttons]');
      if (!root) return;
      const sources = vault ? [paypal.FUNDING.PAYPAL] : [paypal.FUNDING.PAYPAL, paypal.FUNDING.PAYLATER];
      for (const source of sources) {
        const buttons = paypal.Buttons({
          fundingSource: source,
          onInit: (_data, actions) => { walletActions.push(actions); if (busy) actions.disable(); },
          style: { layout: 'vertical', shape: 'pill', label: vault ? 'subscribe' : 'pay' },
          [vault ? 'createBillingAgreement' : 'createOrder']: async () => {
            try { const prepared = await prepare(); return await wallet.createPayment(prepared.paymentOptions); }
            catch (error) { freeze(false); feedback.textContent = error.message; throw error; }
          },
          onApprove: async data => {
            try { const payload = await wallet.tokenizePayment(data); await complete(payload.nonce); }
            catch (error) { feedback.textContent = error.message; freeze(false); }
          },
          onCancel: () => { feedback.textContent = 'Payment cancelled. You can try again when ready.'; freeze(false); },
          onError: () => { feedback.textContent = 'PayPal could not complete checkout. Please try again.'; freeze(false); },
        });
        if (buttons.isEligible()) {
          const target = document.createElement('div');
          root.appendChild(target);
          await buttons.render(target);
        }
      }
      feedback.textContent = '';
    }

    async function setupCards() {
      const form = container.querySelector('[data-card-form]');
      if (!form) return;
      const [fields, threeDSecure] = await Promise.all([
        braintree.hostedFields.create({
          client,
          styles: { input: { 'font-size': '16px', 'font-family': 'system-ui, sans-serif', color: '#2C2E2F' }, ':focus': { color: '#2E2DA8' }, '.invalid': { color: '#b42318' } },
          fields: { number: { container: '#card-number', placeholder: 'Card number' }, expirationDate: { container: '#card-expiry', placeholder: 'MM / YY' }, cvv: { container: '#card-cvv', placeholder: 'CVV' } },
        }),
        braintree.threeDSecure.create({ client, version: 2 }),
      ]);
      cardReady = true;
      cardButton.disabled = busy;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        try {
          const prepared = await prepare();
          cardFeedback.textContent = 'Authenticating your card…';
          const tokenized = await fields.tokenize();
          const verified = await threeDSecure.verifyCard({
            amount: prepared.amount, nonce: tokenized.nonce, bin: tokenized.details.bin,
            email: prepared.email, billingAddress: prepared.billingAddress,
            onLookupComplete: (_data, next) => next(),
          });
          if (!(verified.liabilityShifted ?? verified.threeDSecureInfo?.liabilityShifted)) throw new Error('Card authentication was not completed. Please try again.');
          await complete(verified.nonce);
        } catch (error) {
          cardFeedback.textContent = error.message || 'Check your card details and try again.';
          feedback.textContent = '';
          freeze(false);
        }
      });
    }

    const results = await Promise.allSettled([setupWallet(), setupCards()]);
    if (results[0].status === 'rejected') feedback.textContent = 'PayPal checkout is unavailable. Refresh the page to try again.';
    if (results[1].status === 'rejected' && cardFeedback) cardFeedback.textContent = 'Card payments are unavailable. You can still choose PayPal.';
  } catch (error) {
    feedback.textContent = error.message;
    if (cardFeedback) cardFeedback.textContent = 'Card payments are currently unavailable.';
    freeze(false);
  }
})();
