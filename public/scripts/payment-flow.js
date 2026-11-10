(function createBraintreePayments(window) {
    'use strict';

    const API = {
        clientToken: '/api/client-token',
        previewPlan: '/api/billing-plans/preview',
        previewCustomPlan: '/api/demo/billing-plans/preview',
        previewTransaction: '/api/transactions/preview',
        transactions: '/api/transactions',
        billingTransactions: '/api/billing-transactions',
        customBillingTransactions: '/api/demo/billing-transactions'
    };

    let recurringCheckoutPromise;
    let oneTimeCheckoutPromise;

    async function requestJson(url, options) {
        const response = await fetch(url, options);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(payload.error || `Request failed with status ${response.status}.`);
        }

        return payload;
    }

    function postJson(url, body) {
        return requestJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    function getContainer(containerId) {
        const container = document.getElementById(containerId);

        if (!container) {
            throw new Error(`Payment container "${containerId}" was not found.`);
        }

        return container;
    }

    function showContainerMessage(containerId, message, isError) {
        const container = getContainer(containerId);
        container.replaceChildren();

        const status = document.createElement('p');
        status.textContent = message;
        status.style.fontSize = '0.9rem';
        status.style.color = isError ? '#b00020' : '#555';
        container.appendChild(status);
    }

    async function createPayPalCheckout() {
        const config = await requestJson(API.clientToken);
        const client = await braintree.client.create({
            authorization: config.clientToken
        });
        const checkout = await braintree.paypalCheckout.create({ client });

        return {
            checkout,
            currency: config.currency
        };
    }

    function redirectToSuccess(result) {
        const params = new URLSearchParams({
            txnId: result.transactionId
        });

        window.location.assign(`/success?${params.toString()}`);
    }

    function buildPaymentOptions(billingData) {
        const plan = billingData.planDetails;
        const options = {
            flow: 'vault',
            planType: 'RECURRING'
        };

        switch (billingData.type) {
            case 'subscription':
                options.planType = 'SUBSCRIPTION';
                options.planMetadata = {
                    billingCycles: [{
                        billingFrequency: '1',
                        billingFrequencyUnit: plan.frequency,
                        numberOfExecutions: '0',
                        sequence: '1',
                        startDate: plan.firstBillingDate,
                        trial: false,
                        pricingScheme: {
                            pricingModel: 'FIXED',
                            price: plan.amount
                        }
                    }],
                    currencyIsoCode: plan.currencyIsoCode,
                    name: plan.description,
                    totalAmount: plan.amount
                };
                break;
            case 'recurring':
                options.planMetadata = {
                    billingCycles: [{
                        billingFrequency: '1',
                        billingFrequencyUnit: plan.frequency,
                        numberOfExecutions: '0',
                        sequence: '1',
                        startDate: plan.firstBillingDate,
                        trial: false,
                        pricingScheme: {
                            pricingModel: 'VARIABLE',
                            price: plan.amount
                        }
                    }],
                    currencyIsoCode: plan.currencyIsoCode,
                    name: plan.description,
                    totalAmount: plan.amount
                };
                break;
            case 'unscheduled':
                options.requestBillingAgreement = true;
                options.planType = 'UNSCHEDULED';
                options.planMetadata = {
                    billingCycles: [{
                        sequence: '1',
                        trial: false,
                        pricingScheme: {
                            pricingModel: 'AUTO_RELOAD',
                            price: plan.reloadAmount,
                            reloadThresholdAmount: plan.reloadThreshold
                        }
                    }],
                    currencyIsoCode: plan.currencyIsoCode,
                    name: plan.description,
                    totalAmount: plan.reloadAmount
                };
                break;
            case 'installments':
                options.planType = 'INSTALLMENTS';
                options.planMetadata = {
                    billingCycles: [{
                        billingFrequency: '1',
                        billingFrequencyUnit: plan.frequency,
                        numberOfExecutions: String(plan.totalCycles - 1),
                        sequence: '1',
                        startDate: plan.firstBillingDate,
                        trial: false,
                        pricingScheme: {
                            pricingModel: 'FIXED',
                            price: plan.amount
                        }
                    }],
                    currencyIsoCode: plan.currencyIsoCode,
                    name: plan.description,
                    totalAmount: plan.amount
                };
                break;
            case 'hybrid':
                options.planType = 'SUBSCRIPTION';
                options.planMetadata = {
                    billingCycles: [{
                        billingFrequency: '1',
                        billingFrequencyUnit: plan.frequency,
                        numberOfExecutions: '0',
                        sequence: '1',
                        startDate: plan.firstBillingDate,
                        trial: false,
                        pricingScheme: {
                            pricingModel: 'FIXED',
                            price: plan.recurringAmount
                        }
                    }],
                    currencyIsoCode: plan.currencyIsoCode,
                    name: plan.description,
                    oneTimeFeeAmount: plan.setupFee,
                    totalAmount: plan.setupFee
                };
                break;
            default:
                throw new Error('Unsupported billing type.');
        }

        return options;
    }

    async function getRecurringCheckout() {
        if (!recurringCheckoutPromise) {
            recurringCheckoutPromise = createPayPalCheckout()
                .then(async ({ checkout, currency }) => {
                    await checkout.loadPayPalSDK({ vault: true, currency });
                    return { checkout, currency };
                })
                .catch(error => {
                    recurringCheckoutPromise = undefined;
                    throw error;
                });
        }

        return recurringCheckoutPromise;
    }

    async function initializeRecurring(billingData) {
        const containerId = billingData.containerId || 'paypal-button-container';
        showContainerMessage(containerId, 'Loading secure Braintree checkout…', false);

        try {
            const isCustomDemo = billingData.custom === true;
            const previewUrl = isCustomDemo ? API.previewCustomPlan : API.previewPlan;
            const transactionUrl = isCustomDemo ? API.customBillingTransactions : API.billingTransactions;
            const preview = await postJson(previewUrl, billingData);
            const approvedPlan = {
                type: preview.planType,
                planDetails: preview.planDetails
            };

            const { checkout, currency } = await getRecurringCheckout();
            if (currency !== approvedPlan.planDetails.currencyIsoCode) {
                throw new Error('The Braintree client-token currency does not match the billing plan currency.');
            }

            getContainer(containerId).replaceChildren();
            return paypal.Buttons({
                fundingSource: paypal.FUNDING.PAYPAL,
                createBillingAgreement() {
                    return checkout.createPayment(buildPaymentOptions(approvedPlan));
                },
                async onApprove(data) {
                    const payload = await checkout.tokenizePayment(data);
                    const result = await postJson(transactionUrl, {
                        nonce: payload.nonce,
                        quoteToken: preview.quoteToken,
                        paypalEmail: payload.details?.email
                    });
                    redirectToSuccess(result);
                },
                onError(error) {
                    showContainerMessage(containerId, error.message || 'Braintree checkout failed.', true);
                }
            }).render(`#${containerId}`);
        } catch (error) {
            showContainerMessage(containerId, error.message || 'Braintree checkout failed to load.', true);
            throw error;
        }
    }

    async function getOneTimeCheckout() {
        if (!oneTimeCheckoutPromise) {
            oneTimeCheckoutPromise = createPayPalCheckout()
                .then(async ({ checkout, currency }) => {
                    await checkout.loadPayPalSDK({ currency, intent: 'capture' });
                    return { checkout, currency };
                })
                .catch(error => {
                    oneTimeCheckoutPromise = undefined;
                    throw error;
                });
        }

        return oneTimeCheckoutPromise;
    }

    async function initializeOneTime(billingData) {
        const containerId = billingData.containerId || 'paypal-button-container';
        showContainerMessage(containerId, 'Loading secure Braintree checkout…', false);

        try {
            const { checkout, currency } = await getOneTimeCheckout();
            let quotedPurchase;
            getContainer(containerId).replaceChildren();

            return paypal.Buttons({
                fundingSource: paypal.FUNDING.PAYPAL,
                async createOrder() {
                    const selection = {
                        productId: billingData.productId,
                        storage: billingData.storage,
                        colour: billingData.colour
                    };
                    const quote = await postJson(API.previewTransaction, selection);
                    if (quote.currency !== currency) {
                        throw new Error('The Braintree client-token currency does not match the purchase currency.');
                    }
                    quotedPurchase = { ...selection, ...quote };
                    billingData.amount = quote.amount;
                    billingData.description = quote.description;

                    return checkout.createPayment({
                        flow: 'checkout',
                        intent: 'capture',
                        amount: Number(billingData.amount).toFixed(2),
                        currency,
                        enableShippingAddress: false
                    });
                },
                async onApprove(data) {
                    if (!quotedPurchase) {
                        throw new Error('The Braintree purchase quote is missing.');
                    }

                    const payload = await checkout.tokenizePayment(data);
                    const result = await postJson(API.transactions, {
                        nonce: payload.nonce,
                        quoteToken: quotedPurchase.quoteToken,
                        paypalEmail: payload.details?.email
                    });
                    redirectToSuccess(result);
                },
                onError(error) {
                    showContainerMessage(containerId, error.message || 'Braintree checkout failed.', true);
                }
            }).render(`#${containerId}`);
        } catch (error) {
            showContainerMessage(containerId, error.message || 'Braintree checkout failed to load.', true);
            throw error;
        }
    }

    window.BraintreePayments = {
        initializeRecurring,
        initializeOneTime
    };
}(window));
