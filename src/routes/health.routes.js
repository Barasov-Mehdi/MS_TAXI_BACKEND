const router = require('express').Router();
const mongoose = require('mongoose');

// Liveness: proses canlıdır.
router.get('/', (req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  // Readiness: baza yoxdursa 503 qaytarılır ki, load balancer trafiki başqa instansiyaya yönləndirsin.
  res.status(mongoUp ? 200 : 503).json({
    success: mongoUp,
    data: {
      status: mongoUp ? 'ok' : 'degraded',
      uptime: process.uptime(),
      mongo: mongoUp ? 'connected' : 'disconnected',
    },
    error: null,
    meta: {},
  });
});

module.exports = router;
