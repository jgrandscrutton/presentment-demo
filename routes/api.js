const express = require('express');
const router = express.Router();
require("dotenv").config();
const {
    ApiError,
    CheckoutPaymentIntent,
    Client,
    Environment,
    LogLevel,
    OrdersController,
    PaymentsController,
    PaypalExperienceLandingPage,
    PaypalExperienceUserAction,
    ShippingPreference,
} = require("@paypal/paypal-server-sdk");
const bodyParser = require("body-parser");

const {
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PORT = 8080,
} = process.env;

router.get('/', (req, res) => {
  res.json({ message: 'API is running' });
});


//PayPal Client Setup
const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: PAYPAL_CLIENT_ID,
        oAuthClientSecret: PAYPAL_CLIENT_SECRET,
    },
    timeout: 0,
    environment: Environment.Sandbox,
    logging: {
        logLevel: LogLevel.Info,  //only show warnings/errors
        logRequest: { logBody: false },
        logResponse: { logHeaders: false },
    },
});

const ordersController = new OrdersController(client);
const paymentsController = new PaymentsController(client);


/**. Create an order to start the transaction.  */
const createOrder = async (cart) => {
    const total = cart.reduce((sum, item) => sum + (item.upfrontPrice * item.quantity), 0);
    const payload = {
        body: {
            intent: "CAPTURE",
            purchaseUnits: [
                {
                    amount: {
                        currencyCode: "GBP",
                        value: total.toFixed(2),
                    },
                },
            ],
        },
        prefer: "return=minimal",
    };

    try {
        const { body, ...httpResponse } = await ordersController.createOrder(
            payload
        );
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
        };
    } catch (error) {
        if (error instanceof ApiError) {
            throw new Error(error.message);
        }
    }
};

router.post("/orders", async (req, res) => {
    try {
        const { cart } = req.body;
        const { jsonResponse, httpStatusCode } = await createOrder(cart);
        console.log("Cart received:", cart);
        console.log(`POST /orders → ${httpStatusCode}`);
        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error(`POST /orders → 500`, error.message);
        res.status(500).json({ error: "Failed to create order." });
    }
});


/**Capture payment for the created order to complete the transaction.  */
const captureOrder = async (orderID) => {
    const collect = {
        id: orderID,
        prefer: "return=minimal",
    };

    try {
        const { body, ...httpResponse } = await ordersController.captureOrder(
            collect
        );
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
        };
    } catch (error) {
        if (error instanceof ApiError) {
            throw new Error(error.message);
        }
    }
};

router.post("/orders/:orderID/capture", async (req, res) => {
    try {
        const { orderID } = req.params;
        const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
        console.log(`POST /orders/${orderID}/capture → ${httpStatusCode}`)

        // Save to session so confirmation page can display it
        if (jsonResponse.status === "COMPLETED") {
            const cart = req.session.cart || [];
            const total = cart.reduce((sum, item) => sum + item.upfrontPrice * item.quantity, 0);
            req.session.lastOrder = {
                cart,
                total,
                account:  req.session.checkoutAccount,
                shipping: req.session.checkoutShipping,
                paypalOrderId: orderID,
            };
            req.session.cart = [];
            delete req.session.checkoutAccount;
            delete req.session.checkoutShipping;
        }

        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error(`POST /orders/capture → 500`, error.message);
        res.status(500).json({ error: "Failed to capture order." });
    }
});

module.exports = router;
