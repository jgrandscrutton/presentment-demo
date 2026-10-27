// public/scripts/payment-flow.js

function initializePayment(billingData) {
    // Fetch plan details from server
    fetch('/api/create-billing-plan', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(billingData)
    })
    .then(response => response.json())
    .then(planData => {
        billingData.planDetails = planData.planDetails;
        console.log('Plan data received:', planData);
        return setupPayPalButton(billingData);
    })
    .catch(() => {
        console.error('Error creating billing plan');
    });
}

function getStoreCurrency(billingData) {
    const planDetails = billingData && billingData.planDetails;
    return (
        (planDetails && (planDetails.currencyIsoCode || planDetails.currency)) ||
        (billingData && billingData.currency) ||
        document.body.dataset.storeCurrency
    );
}

function getStoreZeroAmount() {
    return document.body.dataset.storeZeroAmount || '0';
}

function canonicalAmount(value) {
    return String(value);
}

function setupPayPalButton(billingData) {
    fetch('/api/client-token?paymentType=recurring')
        .then(response => response.text())
        .then(clientToken => {
            return braintree.client.create({
                authorization: clientToken
            });
        })
        .then(clientInstance => {
            return braintree.paypalCheckout.create({
                client: clientInstance
            });
        })
        .then(paypalCheckoutInstance => {
            return paypalCheckoutInstance.loadPayPalSDK({
                vault: true,
                intent: 'tokenize'
            }).then(() => paypalCheckoutInstance);
        })
        .then(paypalCheckoutInstance => {
            return paypal.Buttons({
                fundingSource: paypal.FUNDING.PAYPAL,
                
                createBillingAgreement: function() {
                    const paymentOptions = buildPaymentOptions(billingData);
                    console.log('=== FULL PAYMENT OPTIONS ===');
                    console.log(JSON.stringify(paymentOptions, null, 2));
                    console.log('=========================');
                    
                    return paypalCheckoutInstance.createPayment(paymentOptions);
                },
                
                onApprove: function(data, actions) {
                    return paypalCheckoutInstance.tokenizePayment(data)
                        .then(payload => {
                            return fetch('/api/create-subscription', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    nonce: payload.nonce,
                                    billingData: billingData
                                })
                            });
                        })
                        .then(response => response.json())
                        .then(result => {
                            if (result.success) {
                                const params = new URLSearchParams({
                                    txnId: result.transactionId,
                                    product: billingData.description,
                                    amount: result.amount
                                });
                                
                                // Add recurring amount if applicable
                                if (billingData.planDetails.amount && billingData.type !== 'unscheduled') {
                                    params.append('recurring', billingData.planDetails.amount);
                                    params.append('freq', billingData.frequency);
                                    
                                    // Flag if it's variable billing
                                    if (billingData.type === 'recurring') {
                                        params.append('variable', 'true');
                                    }
                                }

                                params.append('currency', result.currency || getStoreCurrency(billingData));
                                
                                window.location.href = `/success?${params.toString()}`;
                            }
                        });
                },
                
                onError: function() {
                    console.error('PayPal error');
                    alert('An error occurred. Check console for details.');
                }
            }).render('#paypal-button-container');
        })
        .catch(() => {
            console.error('Error setting up PayPal');
        });
}

function buildPaymentOptions(billingData) {
    console.log('Building payment options with billingData:', billingData);
    console.log('planDetails:', billingData.planDetails);
    
    const planDetails = billingData.planDetails;
    
    if (!planDetails) {
        console.error('No planDetails found!');
        return {
        flow: 'vault',
        billingAgreementDescription: billingData.description
        };
    }
    
    // Base options - NOTE: flow is 'vault' not 'checkout'
    const options = {
        flow: 'vault',
        planType: 'RECURRING' // Changed from 'SUBSCRIPTION'
    };
    
    switch(billingData.type) {
        case 'subscription':
            // Fixed amount, fixed schedule, ongoing - no setup fee
            const subStartDate = new Date();
            const subFormattedStartDate = subStartDate.toISOString().split('T')[0];
            
            options.planType = 'SUBSCRIPTION';
            options.planMetadata = {
                billingCycles: [{
                billingFrequency: '1',
                billingFrequencyUnit: planDetails.frequency,
                numberOfExecutions: '0',
                sequence: '1',
                startDate: subFormattedStartDate,
                trial: false,
                pricingScheme: {
                    pricingModel: 'FIXED',
                    price: planDetails.amount
                }
                }],
                currencyIsoCode: getStoreCurrency(billingData),
                name: planDetails.description,
                totalAmount: getStoreZeroAmount() // No upfront charges, billing starts on startDate
            };
            break;

        case 'recurring':
            // Variable amount, fixed schedule - use initial amount
            const recStartDate = new Date();
            const recFormattedStartDate = recStartDate.toISOString().split('T')[0];
            
            console.log('Recurring planDetails:', planDetails);
            console.log('planDetails.amount:', planDetails.amount, 'type:', typeof planDetails.amount);
            
            const initialAmount = canonicalAmount(planDetails.amount);
            
            options.planType = 'RECURRING';
            options.planMetadata = {
                billingCycles: [{
                billingFrequency: '1',
                billingFrequencyUnit: planDetails.frequency,
                numberOfExecutions: '0',
                sequence: '1',
                startDate: recFormattedStartDate,
                trial: false,
                pricingScheme: {
                    pricingModel: 'VARIABLE',
                    price: initialAmount
                }
                }],
                currencyIsoCode: getStoreCurrency(billingData),
                name: planDetails.description,
                totalAmount: getStoreZeroAmount()
            };
            break;

        case 'unscheduled':
            const reloadAmt = canonicalAmount(planDetails.reloadAmount);
            const reloadThresh = canonicalAmount(planDetails.reloadThreshold);
            
            options.flow = 'vault';
            options.requestBillingAgreement = true;
            options.planType = 'UNSCHEDULED';
            
            options.planMetadata = {
                billingCycles: [{
                sequence: 1,
                trial: false,
                pricingScheme: {
                    pricingModel: 'AUTO_RELOAD',
                    price: reloadAmt,
                    reloadThresholdAmount: reloadThresh
                }
                }],
                currencyIsoCode: getStoreCurrency(billingData),
                name: planDetails.description,
                totalAmount: reloadAmt // First reload charged today
            };
            break;
            
        case 'installments':
            const instStartDate = new Date();
            const instFormattedStartDate = instStartDate.toISOString().split('T')[0];
            
            const instAmount = canonicalAmount(planDetails.amount);
            
            options.planType = 'SUBSCRIPTION';
            options.planMetadata = {
                billingCycles: [{
                billingFrequency: '1',
                billingFrequencyUnit: planDetails.frequency,
                numberOfExecutions: planDetails.totalCycles.toString(),
                sequence: '1',
                startDate: instFormattedStartDate,
                trial: false,
                pricingScheme: {
                    pricingModel: 'FIXED',
                    price: instAmount
                }
                }],
                currencyIsoCode: getStoreCurrency(billingData),
                name: planDetails.description,
                totalAmount: getStoreZeroAmount() // No upfront charge
            };
            break;

        case 'hybrid':
            const startDate = new Date();
            startDate.setDate(startDate.getDate());
            const formattedStartDate = startDate.toISOString().split('T')[0];
            
            const setupFee = canonicalAmount(planDetails.setupFee);
            const recurringAmount = canonicalAmount(planDetails.recurringAmount);
            
            options.planType = 'SUBSCRIPTION';
            options.planMetadata = {
                billingCycles: [{
                billingFrequency: '1',
                billingFrequencyUnit: planDetails.frequency,
                numberOfExecutions: '0',
                sequence: '1',
                startDate: formattedStartDate,
                trial: false,
                pricingScheme: {
                    pricingModel: 'FIXED',
                    price: recurringAmount
                }
                }],
                currencyIsoCode: getStoreCurrency(billingData),
                name: planDetails.description,
                // Removed productDescription
                oneTimeFeeAmount: setupFee,
                totalAmount: setupFee
            };
            break;
    }
    
    console.log('Final payment options with planMetadata:', options);
    return options;
}

// One-time payment function for PayPal Checkout
// Create one Braintree client + PayPal Checkout instance per storefront currency.
const oneTimeCheckoutPromises = new Map();

function getOneTimeCheckout(currency) {
    if (!oneTimeCheckoutPromises.has(currency)) {
        const checkoutPromise = fetch('/api/client-token')
            .then(response => response.text())
            .then(clientToken => braintree.client.create({ authorization: clientToken }))
            .then(clientInstance => braintree.paypalCheckout.create({ client: clientInstance }))
            .then(paypalCheckoutInstance =>
                paypalCheckoutInstance.loadPayPalSDK({
                    currency: currency,
                    intent: 'capture'
                }).then(() => paypalCheckoutInstance)
            );
        oneTimeCheckoutPromises.set(currency, checkoutPromise);
    }
    return oneTimeCheckoutPromises.get(currency);
}

// billingData: { description, amount, containerId }
function oneTimePayment(billingData) {
    console.log('oneTimePayment called', billingData);
    const currency = getStoreCurrency(billingData);
    return getOneTimeCheckout(currency)
        .then(paypalCheckoutInstance => {
            return paypal.Buttons({
                fundingSource: paypal.FUNDING.PAYPAL,

                createOrder: function() {
                    return paypalCheckoutInstance.createPayment({
                        flow: 'checkout',
                        intent: 'capture',
                        amount: canonicalAmount(billingData.amount),
                        currency: currency,
                        enableShippingAddress: false
                    });
                },

                onApprove: function(data) {
                    return paypalCheckoutInstance.tokenizePayment(data)
                        .then(payload => {
                            return fetch('/api/create-transaction', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    nonce: payload.nonce,
                                    amount: billingData.amount,
                                    currency: currency,
                                    description: billingData.description
                                })
                            });
                        })
                        .then(response => response.json())
                        .then(result => {
                            if (result.success) {
                                const params = new URLSearchParams({
                                    txnId: result.transactionId,
                                    product: billingData.description,
                                    amount: result.amount,
                                    currency: result.currency || currency
                                });
                                window.location.href = `/success?${params.toString()}`;
                            } else {
                                console.error('Transaction failed');
                                alert('Payment failed: ' + result.error);
                            }
                        });
                },

                onError: function() {
                    console.error('PayPal error');
                    alert('An error occurred. Check console for details.');
                }
            }).render('#' + billingData.containerId);
        })
        .catch(() => {
            console.error('Error setting up one-time PayPal button');
            const el = document.getElementById(billingData.containerId);
            if (el) {
                el.innerHTML = '<p style="color:#b00020;font-size:0.85rem">PayPal button failed to load.</p>';
            }
        });
}
