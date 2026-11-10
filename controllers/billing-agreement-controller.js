const { billingAgreementService } = require('../services/billing-agreement-service');
const { runBillingCycle } = require('../services/billing-scheduler');

async function list(req, res, next) {
  try {
    res.json({ success: true, agreements: await billingAgreementService.list() });
  } catch (error) {
    next(error);
  }
}

async function get(req, res, next) {
  try {
    res.json({ success: true, agreement: await billingAgreementService.get(req.params.id) });
  } catch (error) {
    next(error);
  }
}

async function pause(req, res, next) {
  try {
    const agreement = await billingAgreementService.pause(req.params.id);
    res.json({ success: true, agreement: billingAgreementService.publicAgreement(agreement) });
  } catch (error) {
    next(error);
  }
}

async function resume(req, res, next) {
  try {
    const agreement = await billingAgreementService.resume(req.params.id);
    res.json({ success: true, agreement: billingAgreementService.publicAgreement(agreement) });
  } catch (error) {
    next(error);
  }
}

async function cancel(req, res, next) {
  try {
    const agreement = await billingAgreementService.cancel(req.params.id);
    res.json({ success: true, agreement: billingAgreementService.publicAgreement(agreement) });
  } catch (error) {
    next(error);
  }
}

async function updateAmount(req, res, next) {
  try {
    const agreement = await billingAgreementService.updateVariableAmount(req.params.id, req.body.amount);
    res.json({ success: true, agreement: billingAgreementService.publicAgreement(agreement) });
  } catch (error) {
    next(error);
  }
}

async function charge(req, res, next) {
  try {
    const result = await billingAgreementService.charge(req.params.id, {
      force: true,
      amount: req.body?.amount,
    });
    res.status(result.success ? 201 : 422).json(result);
  } catch (error) {
    next(error);
  }
}

async function recordUsage(req, res, next) {
  try {
    const result = await billingAgreementService.recordUsage(req.params.id, req.body?.amount);
    const status = result.success === false ? 422 : (result.reloaded ? 201 : 200);
    res.status(status).json({ success: result.success !== false, ...result });
  } catch (error) {
    next(error);
  }
}

async function resolveReview(req, res, next) {
  try {
    const agreement = await billingAgreementService.resolveReview(req.params.id, req.body || {});
    res.json({ success: true, agreement });
  } catch (error) {
    next(error);
  }
}

async function runDue(req, res, next) {
  try {
    const results = await runBillingCycle();
    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  get,
  pause,
  resume,
  cancel,
  updateAmount,
  charge,
  recordUsage,
  resolveReview,
  runDue,
};
