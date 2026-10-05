const express = require('express');
const router = express.Router();

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

module.exports = router;