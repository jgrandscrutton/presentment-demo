const environment = require('./config/environment');
const app = require('./app');
const {
    startBillingScheduler,
    stopBillingScheduler,
} = require('./services/billing-scheduler');

async function start() {
    const server = app.listen(environment.port);
    try {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        await startBillingScheduler();
    } catch (error) {
        stopBillingScheduler();
        if (server.listening) {
            await new Promise(resolve => server.close(resolve));
        }
        throw error;
    }

    console.log(`Server is running at http://localhost:${environment.port}`);

    function shutdown() {
        stopBillingScheduler();
        server.close(error => {
            if (error) {
                console.error(error);
                process.exitCode = 1;
            }
        });
    }

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

start().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
