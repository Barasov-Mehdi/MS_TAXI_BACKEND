const jwt = require('jsonwebtoken');
const config = require('../config');
const { User, Customer, Driver } = require('../models');
const { AppError } = require('../utils/errors');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('UNAUTHORIZED', 'Missing token', 401);
    const payload = jwt.verify(token, config.jwt.accessSecret);
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    req.user = user;
    if (user.role === 'CUSTOMER') req.customer = await Customer.findOne({ userId: user._id });
    if (user.role === 'DRIVER') req.driver = await Driver.findOne({ userId: user._id });
    next();
  } catch (e) {
    if (e instanceof AppError) return next(e);
    next(new AppError('UNAUTHORIZED', 'Invalid token', 401));
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN', 'Insufficient role', 403));
    }
    next();
  };
}

module.exports = { authenticate, requireRoles };
