function initPayPal() {
    const paypalFeedback = document.getElementById('paypal-feedback');

    const createCartOrder = async () => {
        const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'cart' }),
        });
        const data = await res.json();
        return data.id;
    };

    const onCartApprove = async (data) => {
        const res = await fetch('/api/paypal/capture-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderID: data.orderID, type: 'cart' }),
        });
        const result = await res.json();
        if (result.success) {
        window.location.href = '/checkout/confirmation';
        } else {
        paypalFeedback.textContent = 'Payment could not be confirmed. Please try again.';
        paypalFeedback.style.display = 'block';
        paypalFeedback.style.background = '#FFEBEE';
        paypalFeedback.style.color = '#C62828';
        }
    };

    const onCartError = () => {
        paypalFeedback.textContent = 'Payment failed. Please try again.';
        paypalFeedback.style.display = 'block';
        paypalFeedback.style.background = '#FFEBEE';
        paypalFeedback.style.color = '#C62828';
    };

    paypal.Buttons({
        fundingSource: paypal.FUNDING.PAYPAL,
        style: { shape: 'pill', label: 'checkout', height: 45 },
        createOrder: createCartOrder,
        onApprove: onCartApprove,
        onError: onCartError,
    }).render('#paypal-button-container');

    const payLaterButton = paypal.Buttons({
        fundingSource: paypal.FUNDING.PAYLATER,
        style: { shape: 'pill', color: 'gold', height: 45 },
        createOrder: createCartOrder,
        onApprove: onCartApprove,
        onError: onCartError,
    });
    if (payLaterButton.isEligible()) {
        payLaterButton.render('#paylater-button-container');
    }
}
