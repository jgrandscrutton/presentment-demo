const express = require('express');
const router = express.Router();

router.get('/', (req, res, next) => {
    res.render('basic', {
        title: 'Recurring Billing',
        layout: 'store'
    });
});

module.exports = router;