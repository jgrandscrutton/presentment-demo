const express = require('express');
const router = express.Router();
const devices = require('../data/devices');

router.get('/', (req, res, next) => {
    res.render('index', { title: 'Recurring Billing' });
});

router.get('/subscription', (req, res, next) => {
    res.render('subscription', { 
        title: 'Unlimited Data Plan'
    });
});

router.get('/recurring', (req, res, next) => {
    res.render('recurring', { 
        title: 'Pay As You Go Plan'
    });
});

router.get('/installments', (req, res, next) => {
    res.render('installments', { 
        title: 'iPhone 15'
    });
});

router.get('/bundled', (req, res, next) => {
    res.render('bundled', { 
        title: 'Phone + Plan Bundle'
    });
});

router.get('/unscheduled', (req, res, next) => {
    res.render('unscheduled', { 
        title: 'Auto-Reload Prepaid'
    });
});

router.get('/success', (req, res, next) => {
    res.render('success', { 
        title: 'Payment Successful',
        transactionId: req.query.txnId || 'N/A',
        productName: req.query.product || 'N/A',
        amount: req.query.amount || '0.00',
        recurringAmount: req.query.recurring || null,
        frequency: req.query.freq || 'month',
        paypalEmail: req.query.email || 'N/A',
        isVariable: req.query.variable === 'true' // Add this flag
    });
});

router.get('/webhook-activity', (req, res) => {
    res.render('webhook-activity', {
        title: 'Webhook Activity'
    });
});

router.get('/devices', (req, res) => {
    const { category } = req.query;
    const filtered = category ? devices.filter(d => d.category === category) : devices;

    res.render('devices', {
        title: 'Devices',
        devices: filtered.map(d => ({ ...d, monthlyPrice: d.storage[0].monthlyPrice, upfrontPrice: d.storage[0].upfrontPrice })),
        activeCategory: category || 'all'
    });
});

router.get('/devices/:id', (req, res) => {
    const device = devices.find(d => d.id === req.params.id);
    if (!device) return res.status(404).send('Device not found');

    res.render('device-detail', {
        title: `${device.brand} ${device.name}`,
        device: { ...device, upfrontPrice: device.storage[0].upfrontPrice },
        fullSpecsArray: Object.entries(device.fullSpecs).map(([label, value]) => ({ label, value }))
    });
});

module.exports = router;