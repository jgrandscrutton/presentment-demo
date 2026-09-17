async function onPayPalWebSdkLoaded() {
    const config = window.PAYPAL_CONFIG || {};
    console.log("Amount:", config.amount);
    const feedbackEl = document.getElementById(config.feedbackElementId || 'paypal-feedback');

    const showFeedback = (message, isError) => {
        if (!feedbackEl) return;
        feedbackEl.textContent = message;
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = isError ? '#FFEBEE' : '#E8F5E9';
        feedbackEl.style.color = isError ? '#C62828' : '#2E7D32';
    };

    //Create Order 
    const createOrder = async () => {
        const extraFields = typeof config.getOrderPayload === 'function' ? config.getOrderPayload() : {};
        //console.log("Extra Fields:", extraFields);
        //send extraFields asline items ...
        const res = await fetch('/api/paypal/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: config.orderType, ...extraFields }),
        });

        const order = await res.json();
        if (!res.ok || !order.id) {
            console.error('PayPal order creation failed:', order);
            throw new Error(order.error || 'Failed to create order');
        }
        console.log('PayPal order created:', order);
        return { orderId: order.id };
    };

    //On Approval 
    const onApprove = async (data) => {
      const res = await fetch('/api/paypal/capture-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          orderId: data.orderId, 
          type: config.orderType 
        }),
      });
      
      const result = await res.json();
      if (!result.success) {
        showFeedback('Payment could not be confirmed. Please try again.', true);
        return;
      }
      if (config.onSuccessRedirect) {
        window.location.href = config.onSuccessRedirect;
      } else {
        showFeedback('✓ Payment successful! Order ID: ' + result.orderId, false);
      }
    };

    const onError = () => showFeedback('Payment failed. Please try again.', true);

    const paymentSessionOptions = { onApprove, onCancel: onError };

    //Inistialize PayPal SDK
    try {
        const sdkInstance = await window.paypal.createInstance({
          clientId: config.clientId,
          components: ["paypal-payments", "paypal-messages", "card-fields"],
          pageType: "checkout",
          buyerCountry: config.buyerCountry,
          locale: config.locale,
          testBuyerCountry: config.buyerCountry,
        });

        const amount = typeof config.getAmount === 'function' ? config.getAmount() : config.amount;

        const paymentMethods = await sdkInstance.findEligibleMethods({
          currencyCode: config.currencyCode,
          amount,
        });

        sdkInstance.createPayPalMessages({ currencyCode: config.currencyCode });

        //If PayPal is eligible and configure the button
        if (paymentMethods.isEligible("paypal")) {
          configurePayPalButton(sdkInstance, createOrder, paymentSessionOptions);
          } else { console.log("PayPal is not eligible for this transaction.");
        }

        //If Pay Later is eligible and configure the button
        if (paymentMethods.isEligible("paylater")) {
          const payLaterPaymentMethodDetails = paymentMethods.getDetails("paylater");
          setupPayLaterButton(sdkInstance, payLaterPaymentMethodDetails, createOrder, paymentSessionOptions);
        } else {
          console.log("Pay Later is not eligible for this transaction.");
        }

        //If Cards is eligible and configure the button
        if (paymentMethods.isEligible("advanced_cards")) {
          // Create card fields session
          const cardSession = sdkInstance.createCardFieldsOneTimePaymentSession();

          // Create and mount field components
          const numberField = cardSession.createCardFieldsComponent({
            type: "number",
            placeholder: "Card number",
            style: {
              input: {
                fontSize: "16px",
                fontFamily: "courier, monospace",
                fontWeight: "lighter",
                color: "#ccc",
                },
              ".invalid": { color: "#e53e3e" },
            },
          });

          const expiryField = cardSession.createCardFieldsComponent({ type: "expiry", placeholder: "MM/YY" });
          const cvvField = cardSession.createCardFieldsComponent({ type: "cvv", placeholder: "CVV" });

          document.getElementById("card-number").appendChild(numberField);
          document.getElementById("card-expiry").appendChild(expiryField);
          document.getElementById("card-cvv").appendChild(cvvField);


          // Handle submission
          document
            .getElementById("pay-button")
            .addEventListener("click", async () => {
              try {
                const { orderId } = await createOrder();
                const { data, state } = await cardSession.submit(orderId, {
                  billingAddress: { postalCode: "10001" },
                });
                console.log("Card payment state:", state, "Data:", data);
                switch (state) {
                  case "succeeded":
                    // 3DS may or may not have run; check liabilityShift
                     const captureRes = await fetch('/api/paypal/capture-order', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ orderId: data.orderId, type: config.orderType }),
                    });
                    
                    const result = await captureRes.json();
                    if (!result.success) {
                      showFeedback('Payment could not be confirmed. Please try again.', true);
                      break;
                    }
                    if (config.onSuccessRedirect) {
                      window.location.href = config.onSuccessRedirect;
                    } else {
                      showFeedback('✓ Payment successful! Order ID: ' + result.orderId, false);
                    }
                    break;
                  case "canceled":
                    // Buyer dismissed 3DS — allow retry without a new session
                    showFeedback("Authentication cancelled. Please try again.");
                    break;
                  case "failed" || "failed Data":
                    showFeedback(
                      data?.message || "Payment failed. Check your card details.",
                    );
                    break;
                }
              } catch (err) {
                console.error("Card payment error:", err);
                showFeedback("An unexpected error occurred. Please try again.");
              }
            });

          // const cardPaymentMethodDetails = paymentMethods.getDetails("card");
          // setUpCardButton(sdkInstance, paypalcardPaymentMethodDetails, createOrder, paymentSessionOptions);

        } else {
          console.log("Card is not eligible for this transaction.");
        }

    } catch (error) {
        console.error("SDK initialization error:", error);
    }
}

// Set up PayPal button
function configurePayPalButton(sdkInstance, createOrder, paymentSessionOptions) {
  const paypalPaymentSession = sdkInstance.createPayPalOneTimePaymentSession(paymentSessionOptions);
  const paypalButton = document.querySelector("paypal-button");
  if (!paypalButton) return;
  paypalButton.addEventListener("click", async () => {
    try {
      await paypalPaymentSession.start({ presentationMode: "auto" }, createOrder());
    } catch (error) {
      console.error("PayPal payment start error:", error);
    }
  });
}

// Set up Pay Later button
function setupPayLaterButton(sdkInstance, payLaterPaymentMethodDetails, createOrder, paymentSessionOptions) {
  const payLaterPaymentSession = sdkInstance.createPayLaterOneTimePaymentSession(paymentSessionOptions);
  const { productCode, countryCode } = payLaterPaymentMethodDetails;
  const payLaterButton = document.querySelector("paypal-pay-later-button");

  if (!payLaterButton) return;
  payLaterButton.productCode = productCode;
  payLaterButton.countryCode = countryCode;
  payLaterButton.addEventListener("click", async () => {
    try {
      await payLaterPaymentSession.start({ presentationMode: "auto" }, createOrder());
    } catch (error) {
      console.error("Pay Later payment start error:", error);
    }
  });
}

// Set up card button
// async function setUpCardButton(sdkInstance, paypalcardPaymentMethodDetails) {
//   const paypalcardPaymentSession = sdkInstance.createCardFieldsOneTimePaymentSession(
//     paymentSessionOptions
//   );
//   const { countryCode } = paypalcardPaymentMethodDetails;
//   const numberField = cardSession.createCardFieldsComponent({
//     type: "number",
//     placeholder: "Card number",
//   });
//   const paypalcardButton = document.getElementById("card-number-container").appendChild(numberField);

//   paypalcardButton.countryCode = countryCode;
//   paypalcardButton.removeAttribute("hidden");
//   paypalcardButton.addEventListener("click", async () => {
//     try {
//       await paypalcardPaymentSession.start(
//         { presentationMode: "auto" },
//         createOrder(),
//       );
//     } catch (error) {
//       console.error("PayPal card payment start error:", error);
//     }
//   });
// }