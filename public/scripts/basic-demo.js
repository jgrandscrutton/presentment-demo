(function initializeBasicDemo() {
    'use strict';

    function commonFields() {
        return `
            <label for="description">Description:</label>
            <input type="text" id="description" placeholder="e.g. Music Streaming Service" required>
        `;
    }

    function fieldsFor(type, currency) {
        const common = commonFields();

        switch (type) {
            case 'subscription':
            case 'recurring':
                return `${common}
                    <label for="amount">Amount (${currency}):</label>
                    <input type="number" id="amount" min="0.01" step="0.01" required>
                    <label for="frequency">Billing Frequency:</label>
                    <select id="frequency">
                        <option value="monthly">Monthly</option>
                        <option value="weekly">Weekly</option>
                        <option value="yearly">Yearly</option>
                    </select>
                `;
            case 'unscheduled':
                return `${common}
                    <label for="reloadAmount">Reload Amount (${currency}):</label>
                    <input type="number" id="reloadAmount" min="0.01" step="0.01" required>
                    <label for="reloadThreshold">Reload Threshold (${currency}):</label>
                    <input type="number" id="reloadThreshold" min="0.01" step="0.01" required>
                `;
            case 'installments':
                return `${common}
                    <label for="amount">Amount per Installment (${currency}):</label>
                    <input type="number" id="amount" min="0.01" step="0.01" required>
                    <label for="frequency">Billing Frequency:</label>
                    <select id="frequency">
                        <option value="monthly">Monthly</option>
                        <option value="weekly">Weekly</option>
                        <option value="yearly">Yearly</option>
                    </select>
                    <label for="installments">Number of Installments:</label>
                    <input type="number" id="installments" min="2" max="36" required>
                `;
            case 'hybrid':
                return `${common}
                    <label for="oneTimeAmount">One-time Amount (${currency}):</label>
                    <input type="number" id="oneTimeAmount" min="0.01" step="0.01" required>
                    <label for="recurringAmount">Recurring Amount (${currency}):</label>
                    <input type="number" id="recurringAmount" min="0.01" step="0.01" required>
                    <label for="frequency">Billing Frequency:</label>
                    <select id="frequency">
                        <option value="monthly">Monthly</option>
                        <option value="weekly">Weekly</option>
                        <option value="yearly">Yearly</option>
                    </select>
                `;
            default:
                return '';
        }
    }

    function value(id) {
        return document.getElementById(id)?.value.trim();
    }

    function collectBillingData(type) {
        const billingData = {
            custom: true,
            type,
            description: value('description')
        };

        if (type === 'subscription' || type === 'recurring') {
            billingData.amount = value('amount');
            billingData.frequency = value('frequency');
        } else if (type === 'unscheduled') {
            billingData.reloadAmount = value('reloadAmount');
            billingData.reloadThreshold = value('reloadThreshold');
        } else if (type === 'installments') {
            billingData.amount = value('amount');
            billingData.frequency = value('frequency');
            billingData.installments = value('installments');
        } else if (type === 'hybrid') {
            billingData.oneTimeAmount = value('oneTimeAmount');
            billingData.recurringAmount = value('recurringAmount');
            billingData.frequency = value('frequency');
        }

        return billingData;
    }

    document.addEventListener('DOMContentLoaded', () => {
        const typeSelect = document.getElementById('billing-type');
        const details = document.getElementById('payment-details');
        const continueButton = document.getElementById('continue-btn');
        const currency = document.getElementById('demo-container').dataset.currency;

        typeSelect.addEventListener('change', () => {
            details.replaceChildren();
            document.getElementById('paypal-button-container').replaceChildren();

            if (!typeSelect.value) {
                details.style.display = 'none';
                continueButton.style.display = 'none';
                return;
            }

            details.innerHTML = fieldsFor(typeSelect.value, currency);
            details.style.display = 'block';
            continueButton.style.display = 'block';
        });

        continueButton.addEventListener('click', () => {
            const requiredFields = details.querySelectorAll('[required]');
            if ([...requiredFields].some(field => !field.reportValidity())) {
                return;
            }

            continueButton.disabled = true;
            BraintreePayments.initializeRecurring(collectBillingData(typeSelect.value))
                .then(() => {
                    continueButton.style.display = 'none';
                })
                .catch(error => console.error('Braintree checkout failed:', error))
                .finally(() => {
                    continueButton.disabled = false;
                });
        });
    });
}());
