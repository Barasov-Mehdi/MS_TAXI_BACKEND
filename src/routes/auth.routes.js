const router = require('express').Router();
const Joi = require('joi');
const authService = require('../services/auth.service');
const { authenticate } = require('../middleware/auth');
const { ok } = require('../utils/errors');
const { User } = require('../models');
const { AppError } = require('../utils/errors');

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body);
    if (error) return next(new AppError('VALIDATION_ERROR', error.message, 400));
    req.body = value;
    next();
  };
}

router.post(
  '/register',
  validate(Joi.object({
    role: Joi.string().valid('CUSTOMER', 'DRIVER').required(),
    phone: Joi.string().required(),
    password: Joi.string().min(6).required(),
    firstName: Joi.string().allow(''),
    lastName: Joi.string().allow(''),
    email: Joi.string().email().allow(null, ''),
  })),
  async (req, res, next) => {
    try {
      const user = await authService.register(req.body);
      ok(res, { user: authService.publicUser(user), verifyHint: user.phoneVerifyCode }, {}, 201);
    } catch (e) { next(e); }
  }
);

router.post(
  '/login',
  validate(Joi.object({ phone: Joi.string().required(), password: Joi.string().required() })),
  async (req, res, next) => {
    try {
      ok(res, await authService.login({ ...req.body, ip: req.ip }));
    } catch (e) { next(e); }
  }
);

router.post('/refresh', async (req, res, next) => {
  try {
    ok(res, await authService.refresh(req.body.refreshToken));
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    await authService.logout(req.body.refreshToken);
    ok(res, { loggedOut: true });
  } catch (e) { next(e); }
});

router.post('/verify-phone', authenticate, async (req, res, next) => {
  try {
    const user = await authService.verifyPhone(req.user._id, req.body.code);
    ok(res, { user: authService.publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const user = await User.findOne({ phone: req.body.phone });
    if (user) {
      user.passwordResetCode = String(Math.floor(100000 + Math.random() * 900000));
      user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();
    }
    ok(res, { sent: true });
  } catch (e) { next(e); }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const user = await User.findOne({ phone: req.body.phone, passwordResetCode: req.body.code });
    if (!user || user.passwordResetExpiresAt < new Date()) {
      throw new AppError('INVALID_CODE', 'Invalid reset code', 400);
    }
    user.passwordHash = await User.hashPassword(req.body.password);
    user.passwordResetCode = null;
    await user.save();
    ok(res, { reset: true });
  } catch (e) { next(e); }
});

module.exports = router;
