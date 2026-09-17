async function onPayPalWebSdkLoaded() {
    const config = window.PAYPAL_CONFIG || {};
    const feedbackEl = document.getElementById(config.feedbackElementId || 'paypal-feedback');

    //Show Response Feedback
    const showFeedback = (message, isError) => {
        if (!feedbackEl) return;
        feedbackEl.textContent = message;
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = isError ? '#FFEBEE' : '#E8F5E9';
        feedbackEl.style.color = isError ? '#C62828' : '#2E7D32';
    };

     //Create Order 
    const createVaultSetupToken = async () => {
        const extraFields = typeof config.getOrderPayload === 'function' ? config.getOrderPayload() : {};
        //console.log("Extra Fields:", extraFields);
        //send extraFields asline items ...
        const res = await fetch('/api/paypal/create-setup-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: config.orderType, ...extraFields }),
        });

        const data = await res.json();
        if (!res.ok || !data.id) {
          console.error('Setup token creation failed:', data);
          throw new Error(data.error || 'Failed to create setup token');
        }
        return { vaultSetupToken: data.id };
    };

    //On Approval 
    const onApprove = async (data) => {
        const res = await fetch('/api/paypal/save-payment-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultSetupToken: data.vaultSetupToken, type: config.orderType }),
        });
        const result = await res.json();
        if (!result.success) {
        showFeedback('Payment could not be confirmed. Please try again.', true);
        return;
        }
        if (config.onSuccessRedirect) {
        window.location.href = config.onSuccessRedirect;
        } else {
        showFeedback('✓ Payment method saved. Your plan is being activated.', false);
        }
    };

    //On Cancel
    const onCancel = () => showFeedback('Setup cancelled.', true);

    //On Error
    const onError = (error) => {
      console.error('Save payment error:', error);
      showFeedback('Something went wrong. Please try again.', true);
    };

    const paymentSessionOptions = { onApprove, onCancel, onError };

    try {
        const sdkInstance = await window.paypal.createInstance({
        clientId: config.clientId,
        components: ["paypal-payments", "paypal-messages"],
        pageType: "checkout",
        buyerCountry: config.buyerCountry,
        locale: config.locale,
        testBuyerCountry: config.buyerCountry,
        });

        const amount = typeof config.getAmount === 'function' ? config.getAmount() : config.amount;

        const paymentMethods = await sdkInstance.findEligibleMethods({
          currencyCode: config.currencyCode,
          paymentFlow: "VAULT_WITHOUT_PAYMENT"
        });

        if (paymentMethods.isEligible("paypal")) {
        configureSavePaymentButton(sdkInstance, createVaultSetupToken, paymentSessionOptions);
        } else {
        console.log("PayPal is not eligible for this transaction.");
        }

    } catch (error) {
        console.error("SDK initialization error:", error);
    }

};

function configureSavePaymentButton(sdkInstance, createVaultSetupToken, paymentSessionOptions) {
  const paypalPaymentSession = sdkInstance.createPayPalSavePaymentSession(paymentSessionOptions);
  const paypalButton = document.querySelector("paypal-button");
  if (!paypalButton) return;

  paypalButton.addEventListener("click", async () => {
    try {
      const setupTokenPromise = createVaultSetupToken(); // do not await here
      await paypalPaymentSession.start({ presentationMode: "auto" }, setupTokenPromise);
    } catch (error) {
      console.error("Save payment start error:", error);
    }
  });
}


