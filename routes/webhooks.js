const express = require('express');
const { redact } = require('../lib/inspector/redact');
const router = express.Router();

// In-memory storage for webhook events (resets on server restart)
const webhookEvents = [];
const MAX_EVENTS = 50;

// Webhook for PayPal/Braintree events
router.post('/paypal', (req, res) => {
    console.log('PayPal webhook received');
    
    // TODO: Verify webhook signature
    // TODO: Handle different event types
    
    res.status(200).send('OK');
});

// You can add more webhook endpoints
router.post('/braintree', (req, res) => {
    const safeBody = redact(req.body || {});
    const eventType = safeBody.kind || safeBody.event_type;
    const event = {
        timestamp: new Date().toISOString(),
        type: typeof eventType === 'string' ? eventType.slice(0, 120) : 'unknown',
        data: safeBody,
        receivedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })
    };
    
    console.log(`Braintree webhook received: ${event.type}`);

    // Store event (keep last 50)
    webhookEvents.unshift(event);
    if (webhookEvents.length > MAX_EVENTS) {
        webhookEvents.pop();
    }
    
    res.status(200).send('OK');
});

// Get recent webhook events
router.get('/activity', (req, res) => {
    res.json({
        events: webhookEvents,
        count: webhookEvents.length
    });
});

module.exports = router;
