const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');
const logger = require('morgan');
const environment = require('./config/environment');

const storeRouter = require('./routes/store');
const basicRouter = require('./routes/basic')
const apiRouter = require('./routes/api');

const app = express();
const currencyPart = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: environment.braintree.currency,
  currencyDisplay: 'narrowSymbol',
}).formatToParts(0).find(part => part.type === 'currency');

app.locals.currency = environment.braintree.currency;
app.locals.currencySymbol = currencyPart?.value || environment.braintree.currency;

app.set('views', path.join(__dirname, 'views'));
app.engine('hbs', exphbs.engine({ 
  extname: '.hbs',
  defaultLayout: 'store',
  helpers: {
    eq: (a, b) => a === b,
    gt: (a, b) => a > b,
  }
}));
app.set('view engine', 'hbs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', storeRouter);
app.use('/basic', basicRouter);
app.use('/api', apiRouter);

app.use((req, res) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    res.status(404).json({ success: false, error: 'API endpoint not found.' });
    return;
  }

  res.status(404).send('Page not found.');
});

app.use((error, req, res, _next) => {
  const status = error.statusCode || 500;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Braintree request failed.' : error.message,
  });
});

module.exports = app;
