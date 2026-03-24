const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'API is running' });
});

router.use('/paypal', require('./paypal'));

module.exports = router;
