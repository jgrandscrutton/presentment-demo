# PhonePal — PayPal Presentment Demo

A phone retail e-commerce demo app showcasing PayPal payment integration, including PayPal Wallet, Pay Later messaging, and subscription billing via PayPal Vault.

## Overview

PhonePal is a fictional UK telecoms retailer built with Node.js and Express. It demonstrates end-to-end PayPal Presentment features across the customer journey — from browsing devices and plans through to checkout and payment capture.

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js v5
- **Templating**: Handlebars (express-handlebars)
- **Sessions**: express-session (in-memory)
- **Payments**: PayPal REST APIs (v2 Orders, v3 Vault)
- **Frontend**: Vanilla HTML/CSS/JS

## Getting Started

### Prerequisites

- Node.js (v18+)
- A PayPal developer account with sandbox credentials ([developer.paypal.com](https://developer.paypal.com))

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in your PayPal sandbox credentials:

```env
PORT=3000
SESSION_SECRET=change-me-in-production

PAYPAL_CLIENT_ID=your_paypal_client_id_here
PAYPAL_CLIENT_SECRET=your_paypal_client_secret_here
PAYPAL_MODE=sandbox
PAYPAL_BUYER_COUNTRY=GB
```

### Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Features

### Devices & Plans
- Browse flagship, mid-range, and budget phones (iPhone 16, Galaxy S25, Pixel 9 Pro, etc.)
- Multiple storage options and colour variants per device
- Fixed and pay-as-you-go (PAYG) billing plans
- Contract length options with discounts (monthly, 12-month, 24-month)

### Shopping & Checkout
- Session-based cart with quantity management
- Multi-step checkout: Account → Shipping → Payment → Confirmation

### PayPal Integration
- **PayPal Wallet button** — on device detail and cart pages
- **Pay Later messaging** — on device detail, cart, and plan pages
- **Order create & capture** — PayPal Orders API v2
- **Billing setup** — PayPal Vault v3 for subscription/plan payment tokens

## Project Structure

```
├── app.js              # Express app setup, middleware, routes
├── server.js           # Entry point
├── routes/
│   ├── devices.js      # Device listing & detail
│   ├── cart.js         # Cart management
│   ├── checkout.js     # Checkout flow
│   ├── plans.js        # Plans listing & detail
│   └── paypal.js       # PayPal API endpoints
├── data/
│   ├── devices.js      # Device catalog
│   └── plans.js        # Plans catalog
├── views/              # Handlebars templates
└── public/             # Static assets (CSS, images)
```

## PayPal API Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/paypal/create-order` | Create a PayPal order |
| `POST /api/paypal/capture-order` | Capture a PayPal order |
| `POST /api/paypal/create-setup-token` | Create a Vault setup token (billing plans) |
| `POST /api/paypal/save-payment-token` | Exchange setup token for reusable payment token |
