const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');

const storeRouter = require('./routes/store');
const basicRouter = require('./routes/basic')
const apiRouter = require('./routes/api');

const app = express();

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
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', storeRouter);
app.use('/basic', basicRouter);
app.use('/api', apiRouter)

module.exports = app;