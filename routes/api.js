const braintree = require('braintree');
const express = require('express');
const router = express.Router();
const webhookRouter = require('./webhooks');

const gateway = new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: process.env.MERCHANT_ID,
    publicKey: process.env.PUBLIC_KEY,
    privateKey: process.env.PRIVATE_KEY,
});

router.use('/webhooks', webhookRouter);
console.log('MERCHANT_ACCOUNT_ID:', JSON.stringify(process.env.MERCHANT_ACCOUNT_ID));

router.route('/client-token').get((req, res, next) => {
   gateway.clientToken.generate({merchantAccountId: process.env.MERCHANT_ACCOUNT_ID}, (err, response) => {
    if (err) {
        console.error('Error generating client token:', err);
        return res.status(500).json({ error: err.message });
    }
    res.send(response.clientToken);
   }); 
});

router.route('/create-billing-plan').post((req, res, next) => {
  const { type, description, amount, frequency, installments, oneTimeAmount, recurringAmount, initialPayment } = req.body;
  
  console.log('Creating billing plan for type:', type, req.body);
  
  // Map frequency to billing cycle
  const frequencyMap = {
    'weekly': 'WEEK',
    'monthly': 'MONTH',
    'yearly': 'YEAR'
  };
  
  let planDetails = {};
  
  switch(type) {
    case 'subscription':
      planDetails = {
        description: description,
        amount: amount,
        currency: 'USD',
        frequency: frequencyMap[frequency]
      };
      break;
      
    case 'recurring':
      planDetails = {
        description: description,
        amount: amount,
        currency: 'USD',
        frequency: frequencyMap[frequency]
      };
      break;
      
    case 'unscheduled':
        const { reloadAmount, reloadThreshold } = req.body;
        
        planDetails = {
            description: description,
            reloadAmount: reloadAmount,
            reloadThreshold: reloadThreshold
        };
        break;

    case 'installments':
      planDetails = {
        description: description,
        amount: amount,
        currency: 'USD',
        frequency: frequencyMap[frequency],
        totalCycles: installments
      };
      break;
      
    case 'hybrid':
      planDetails = {
        description: description,
        setupFee: oneTimeAmount,
        recurringAmount: recurringAmount,
        currency: 'USD',
        frequency: frequencyMap[frequency]
      };
      break;
      
    default:
      return res.status(400).json({
        success: false,
        error: 'Invalid billing type'
      });
  }
  
  console.log('Returning plan details:', planDetails);
  
  res.json({
    success: true,
    planType: type,
    planDetails: planDetails
  });
});

// One-time payment: sale using the PayPal nonce
router.route('/create-transaction').post(async (req, res) => {
  const { nonce, amount, description, paypalEmail } = req.body;

  try {
    const result = await gateway.transaction.sale({
      amount: parseFloat(amount).toFixed(2),
      paymentMethodNonce: nonce,
      orderId: description,
      // Must be a GBP merchant account (Braintree charges in the merchant account's currency)
      ...(process.env.MERCHANT_ACCOUNT_ID && { merchantAccountId: process.env.MERCHANT_ACCOUNT_ID }),
      options: { submitForSettlement: true }
    });

    if (result.success) {
      return res.json({
        success: true,
        transactionId: result.transaction.id,
        amount: result.transaction.amount,
        paypalEmail: paypalEmail
      });
    }
    return res.status(400).json({ success: false, error: result.message });
  } catch (error) {
    console.error('Error processing one-time transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.route('/create-subscription').post(async (req, res, next) => {
  const { nonce, billingData, paypalEmail } = req.body;
  
  console.log('Processing payment with nonce:', nonce);
  console.log('Billing type:', billingData.type);
  
  try {
    const planDetails = billingData.planDetails;
    
    switch(billingData.type) {
      case 'subscription':
        // Charge first subscription payment
        const subResult = await gateway.transaction.sale({
          amount: planDetails.amount,
          paymentMethodNonce: nonce,
          options: {
            submitForSettlement: true
          }
        });
        
        if (subResult.success) {
          return res.json({
            success: true,
            transactionId: subResult.transaction.id,
            amount: subResult.transaction.amount,
            paypalEmail: paypalEmail,
            message: `First payment of $${planDetails.amount} processed`
          });
        } else {
          return res.status(400).json({
            success: false,
            error: subResult.message
          });
        }
        
      case 'recurring':
        // Charge initial recurring payment
        const recResult = await gateway.transaction.sale({
          amount: planDetails.amount,
          paymentMethodNonce: nonce,
          options: {
            submitForSettlement: true
          }
        });
        
        if (recResult.success) {
          return res.json({
            success: true,
            transactionId: recResult.transaction.id,
            amount: recResult.transaction.amount,
            paypalEmail: paypalEmail,
            message: `Initial payment of $${planDetails.amount} processed`
          });
        } else {
          return res.status(400).json({
            success: false,
            error: recResult.message
          });
        }
        
      case 'installments':
        // Charge first installment
        const instResult = await gateway.transaction.sale({
          amount: planDetails.amount,
          paymentMethodNonce: nonce,
          options: {
            submitForSettlement: true
          }
        });
        
        if (instResult.success) {
          return res.json({
            success: true,
            transactionId: instResult.transaction.id,
            amount: instResult.transaction.amount,
            paypalEmail: paypalEmail,
            message: `First installment of $${planDetails.amount} processed (${planDetails.totalCycles - 1} remaining)`
          });
        } else {
          return res.status(400).json({
            success: false,
            error: instResult.message
          });
        }
        
      case 'hybrid':
        // Charge setup fee + first recurring payment
        const totalAmount = parseFloat(planDetails.setupFee) + parseFloat(planDetails.recurringAmount);
        
        const hybridResult = await gateway.transaction.sale({
          amount: totalAmount.toFixed(2),
          paymentMethodNonce: nonce,
          options: {
            submitForSettlement: true
          }
        });
        
        if (hybridResult.success) {
          return res.json({
            success: true,
            transactionId: hybridResult.transaction.id,
            amount: hybridResult.transaction.amount,
            paypalEmail: paypalEmail,
            message: `Charged $${planDetails.setupFee} setup + $${planDetails.recurringAmount} first payment`
          });
        } else {
          return res.status(400).json({
            success: false,
            error: hybridResult.message
          });
        }
        
      case 'unscheduled':
        // Charge first reload amount
        const unschAmount = parseFloat(planDetails.reloadAmount);
        
        const unschResult = await gateway.transaction.sale({
            amount: unschAmount.toFixed(2),
            paymentMethodNonce: nonce,
            options: {
            submitForSettlement: true
            }
        });
        
        if (unschResult.success) {
            return res.json({
            success: true,
            transactionId: unschResult.transaction.id,
            amount: unschResult.transaction.amount,
            paypalEmail: paypalEmail,
            message: `First reload of $${unschAmount} processed. Auto-reload when balance drops below $${planDetails.reloadThreshold}`
            });
        } else {
            return res.status(400).json({
            success: false,
            error: unschResult.message
            });
        }
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Unknown billing type'
        });
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;