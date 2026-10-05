const dotenv = require('dotenv');
dotenv.config({ path: './config.env' });
const app = require('./app');

const port = process.env.PORT || 3000;
console.log('Port', port);

// Start Server
const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});