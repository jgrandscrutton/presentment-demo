const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const session = require('express-session');
const { randomUUID } = require('node:crypto');
const { store, billing } = require('./config/payment-runtime');

const storeRouter = require('./routes/store');
const basicRouter = require('./routes/basic')
const apiRouter = require('./routes/api');

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.engine('hbs', exphbs.engine({ 
  extname: '.hbs',
  defaultLayout: 'main',
  helpers: {
    eq: (a, b) => a === b,
    gt: (a, b) => a > b,
    incremented: n => n + 1,
    decremented: n => Math.max(0, n - 1),
    itemTotal: (price, quantity) => (price * quantity).toFixed(2),
    or: (left, right) => Boolean(left || right),
  }
}));
app.set('view engine', 'hbs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || store.secret(),
  store: store.sessions,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));
app.use((req, res, next) => {
  req.session.billingOwner ||= randomUUID();
  res.locals.cartCount = (req.session.cart || []).reduce((sum, item) => sum + item.quantity, 0);
  next();
});

app.use('/api/storefront', require('./routes/storefront-payment')(require('./config/braintree'), { store, billing }));
app.use('/api/billing', require('./routes/billing')({ store, billing }));
app.get('/billing', (req, res) => res.render('billing', { title: 'Your billing', billingDashboard: true }));
app.use('/checkout', require('./routes/checkout'));
app.use('/cart', require('./routes/cart'));
app.use('/devices', require('./routes/devices'));
app.use('/plans', require('./routes/plans'));
app.use('/', require('./routes/index'));
app.use('/', storeRouter);
app.use('/basic', basicRouter);
app.use('/api', apiRouter)

module.exports = app;
