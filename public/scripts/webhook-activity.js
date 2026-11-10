(function initializeWebhookActivity() {
    'use strict';

    function badgeFor(type) {
        const normalizedType = String(type).toLowerCase();

        if (normalizedType.includes('cancel')) {
            return { className: 'badge-cancelled', label: 'CANCELLED' };
        }
        if (normalizedType.includes('create')) {
            return { className: 'badge-created', label: 'CREATED' };
        }
        if (normalizedType.includes('update')) {
            return { className: 'badge-updated', label: 'UPDATED' };
        }

        return { className: 'badge-updated', label: 'EVENT' };
    }

    function message(className, text) {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text;
        return element;
    }

    function eventCard(event) {
        const card = document.createElement('div');
        card.className = 'event-card';

        const header = document.createElement('div');
        header.className = 'event-header';

        const labels = document.createElement('div');
        const type = document.createElement('span');
        type.className = 'event-type';
        type.textContent = event.type;

        const badgeDetails = badgeFor(event.type);
        const badge = document.createElement('span');
        badge.className = `event-badge ${badgeDetails.className}`;
        badge.textContent = badgeDetails.label;
        labels.append(type, badge);

        const receivedAt = document.createElement('div');
        receivedAt.className = 'event-time';
        receivedAt.textContent = event.receivedAt;
        header.append(labels, receivedAt);

        const data = document.createElement('div');
        data.className = 'event-data';
        data.textContent = JSON.stringify(event.data, null, 2);
        card.append(header, data);
        return card;
    }

    function displayEvents(events, count) {
        const countElement = document.getElementById('event-count');
        countElement.textContent = `${count} webhook event${count === 1 ? '' : 's'} received`;

        const container = document.getElementById('events-container');
        container.replaceChildren();

        if (events.length === 0) {
            container.appendChild(message('no-events', 'No verified Braintree webhook events received yet.'));
            return;
        }

        container.append(...events.map(eventCard));
    }

    async function loadWebhookEvents() {
        const container = document.getElementById('events-container');
        container.replaceChildren(message('loading', 'Loading…'));

        try {
            const response = await fetch('/api/webhooks/activity');
            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}.`);
            }

            const payload = await response.json();
            displayEvents(payload.events, payload.count);
        } catch (error) {
            console.error('Could not load Braintree webhook activity:', error);
            container.replaceChildren(message('no-events', 'Unable to load webhook events.'));
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('refresh-events').addEventListener('click', loadWebhookEvents);
        loadWebhookEvents();
        window.setInterval(loadWebhookEvents, 10000);
    });
}());
