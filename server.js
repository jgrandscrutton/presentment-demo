const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const requiredCredentials = ['MERCHANT_ID', 'PUBLIC_KEY', 'PRIVATE_KEY'];
const missingCredentials = requiredCredentials.filter(name => !process.env[name]?.trim());
if (missingCredentials.length > 0) {
    throw new Error(`Missing Braintree credentials: ${missingCredentials.join(', ')}. Add them to .env before starting the server.`);
}

const app = require('./app');
const { billing } = require('./config/payment-runtime');

const port = process.env.PORT || 3000;
console.log('Port', port);

// Start Server
const server = app.listen(port, error => {
    if (error) {
        console.error('Failed to start server:', error.message);
        process.exitCode = 1;
        return;
    }
    console.log(`Server is running at http://localhost:${server.address().port}`);
    billing.tick().catch(() => console.error('Billing reconciliation will retry on the next interval.'));
});
const billingTimer = setInterval(() => billing.tick().catch(() => console.error('Billing reconciliation will retry on the next interval.')), 60000);
billingTimer.unref();
server.on('close', () => clearInterval(billingTimer));
