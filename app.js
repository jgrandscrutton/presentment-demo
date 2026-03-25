const express = require('express');
const session = require('express-session');
const { engine } = require('express-handlebars');
const path = require('path');

const app = express();

app.engine('hbs', engine({
  extname: '.hbs',
  helpers: {
    eq: (a, b) => a === b,
    gt: (a, b) => a > b,
    incremented: (n) => n + 1,
    decremented: (n) => Math.max(0, n - 1),
    itemTotal: (price, qty) => price * qty,
  },
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: true,
}));

// Make cart count and PayPal client ID available to all views
app.use((req, res, next) => {
  const cart = req.session.cart || [];
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  res.locals.cartCount = cartCount;
  res.locals.paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
  res.locals.paypalBuyerCountry = process.env.PAYPAL_BUYER_COUNTRY || 'GB';
  next();
});

app.use('/api', require('./routes/api'));
app.use('/checkout', require('./routes/checkout'));
app.use('/cart', require('./routes/cart'));
app.use('/devices', require('./routes/devices'));
app.use('/plans', require('./routes/plans'));
app.use('/', require('./routes'));

module.exports = app;
