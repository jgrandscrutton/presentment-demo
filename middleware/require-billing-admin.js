const crypto = require('node:crypto');
const environment = require('../config/environment');

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left || '', 'utf8');
  const rightBuffer = Buffer.from(right || '', 'utf8');

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireBillingAdmin(req, res, next) {
  if (!environment.billing.adminKey) {
    res.status(503).json({
      success: false,
      error: 'Billing administration is disabled until BILLING_ADMIN_KEY is configured.',
    });
    return;
  }

  if (!secureEqual(req.get('x-billing-admin-key'), environment.billing.adminKey)) {
    res.status(401).json({ success: false, error: 'Invalid billing administrator key.' });
    return;
  }

  next();
}

module.exports = requireBillingAdmin;
