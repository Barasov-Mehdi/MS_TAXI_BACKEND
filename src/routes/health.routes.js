const router = require('express').Router();
const mongoose = require('mongoose');
const redis = require('../utils/redis');

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
      // Redis məcburi deyil (yoxdursa tək instansiya rejimi): vəziyyət yalnız məlumat üçündür
      redis: redis.enabled() ? (redis.isReady() ? 'connected' : 'connecting') : 'disabled',
      instance: process.env.DYNO || 'local',
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    },
    error: null,
    meta: {},
  });
});

module.exports = router;
