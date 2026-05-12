console.log(window.shippingAddress)
//Card Fields Setup
const cardField = window.paypal.CardFields({
    createOrder: createOrderCallback,
    onApprove: onApproveCallback,
    style: {
        input: {
            "font-size": "16px",
            "font-family": "courier, monospace",
            "font-weight": "lighter",
            color: "#ccc",
        },
        ".invalid": { color: "purple" },
    },
});

if (cardField.isEligible()) {

    const nameField = cardField.NameField({
        style: { input: { color: "blue" }, ".invalid": { color: "purple" } },
    });
    nameField.render("#card-name");

    const numberField = cardField.NumberField({
        style: { input: { color: "blue" } },
    });
    numberField.render("#card-number");

    const cvvField = cardField.CVVField({
        style: { input: { color: "blue" } },
    });
    cvvField.render("#card-cvc");

    const expiryField = cardField.ExpiryField({
        style: { input: { color: "blue" } },
    });
    expiryField.render("#card-expiry");

    document.getElementById("card-field-submit-button")
        .addEventListener("click", (event) => {
            event.preventDefault();

            const sameAsShipping = document.getElementById("same-as-shipping").checked;
            const billing = sameAsShipping ? {
                addressLine1: window.shippingAddress.line1,
                city:         window.shippingAddress.city,
                postalCode:   window.shippingAddress.postcode,
                countryCode:  window.shippingAddress.country,
            } : {
                addressLine1: document.getElementById("card-billing-address-line-1").value,
                city:         document.getElementById("card-billing-address-city").value,
                postalCode:   document.getElementById("card-billing-address-postal-code").value,
                countryCode:  document.getElementById("card-billing-address-country-code").value,
            };

            cardField.submit({ billingAddress: billing });
        });
}


//Call backs
async function createOrderCallback() {
    try {
        const response = await fetch("/api/orders", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                cart: window.cartItems,
            }),
        });

        const orderData = await response.json();

        if (orderData.id) {
            return orderData.id;
        } else {
            const errorDetail = orderData?.details?.[0];
            const errorMessage = errorDetail
                ? `${errorDetail.issue} ${errorDetail.description} (${orderData.debug_id})`
                : JSON.stringify(orderData);

            throw new Error(errorMessage);
        }
    } catch (error) {
        console.error(error);
    }
}

async function onApproveCallback(data, actions) {
    try {
        const response = await fetch(`/api/orders/${data.orderID}/capture`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
        });

        const orderData = await response.json();

        const transaction =
            orderData?.purchase_units?.[0]?.payments?.captures?.[0] ||
            orderData?.purchase_units?.[0]?.payments?.authorizations?.[0];
        const errorDetail = orderData?.details?.[0];

        if (errorDetail || !transaction || transaction.status === "DECLINED") {
            // (2) Non-recoverable error
            let errorMessage;
            if (transaction) {
                errorMessage = `Transaction ${transaction.status}: ${transaction.id}`;
            } else if (errorDetail) {
                errorMessage = `${errorDetail.description} (${orderData.debug_id})`;
            } else {
                errorMessage = JSON.stringify(orderData);
            }
            throw new Error(errorMessage);
        } else {
            // (3) Success
            console.log(
                `Transaction ${transaction.status}: ${transaction.id}<br><br>See console for all available details`
            );
            console.log("Capture result", orderData, JSON.stringify(orderData, null, 2));
            window.location.href = '/checkout/confirmation';
        }
    } catch (error) {
        console.error(error);
    }
}
