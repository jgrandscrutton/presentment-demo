const express = require('express');
const router = express.Router();
const { fixedPlans, paygPlans, allPlans } = require('../data/plans');

router.get('/', (req, res) => {
  res.render('plans', {
    title: 'Plans',
    fixedPlans,
    paygPlans,
  });
});

router.get('/:id', (req, res) => {
  const plan = allPlans.find(p => p.id === req.params.id);
  if (!plan) return res.status(404).render('404', { title: 'Not Found' });

  const related = allPlans
    .filter(p => p.type === plan.type && p.id !== plan.id)
    .slice(0, 2);

  let contractPrices = null;
  if (plan.type === 'fixed') {
    contractPrices = plan.contractLengths.map(cl => ({
      ...cl,
      effectiveMonthlyPrice: +(plan.baseMonthlyPrice * (1 - cl.discountPct / 100)).toFixed(2),
      totalCycles: cl.months === 1 ? 0 : cl.months,
    }));
  }

  res.render('plan-detail', {
    title: `${plan.name} Plan`,
    plan,
    contractPrices,
    related,
  });
});

module.exports = router;
