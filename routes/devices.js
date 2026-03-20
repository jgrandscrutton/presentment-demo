const express = require('express');
const router = express.Router();
const devices = require('../data/devices');

router.get('/', (req, res) => {
  const { category } = req.query;
  const filtered = category ? devices.filter(d => d.category === category) : devices;

  res.render('devices', {
    title: 'Devices',
    devices: filtered.map(d => ({ ...d, monthlyPrice: d.storage[0].monthlyPrice, upfrontPrice: d.storage[0].upfrontPrice })),
    activeCategory: category || 'all',
  });
});

router.get('/:id', (req, res) => {
  const device = devices.find(d => d.id === req.params.id);
  if (!device) return res.status(404).render('404', { title: 'Not Found' });

  const related = devices
    .filter(d => d.category === device.category && d.id !== device.id)
    .slice(0, 3)
    .map(d => ({ ...d, monthlyPrice: d.storage[0].monthlyPrice, upfrontPrice: d.storage[0].upfrontPrice }));

  const fullSpecsArray = Object.entries(device.fullSpecs).map(([label, value]) => ({ label, value }));

  res.render('device-detail', {
    title: `${device.brand} ${device.name}`,
    device: {
      ...device,
      monthlyPrice: device.storage[0].monthlyPrice,
      upfrontPrice: device.storage[0].upfrontPrice,
    },
    fullSpecsArray,
    related,
  });
});

module.exports = router;
