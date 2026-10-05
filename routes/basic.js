const express = require('express');
const router = express.Router();

router.get('/', (req, res, next) => {
    res.render('basic', {
        title: 'Recurring Billing',
        layout: 'main'
    });
});

module.exports = router;