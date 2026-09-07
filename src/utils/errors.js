class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = status === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;
  res.status(status).json({
    success: false,
    data: null,
    error: { code, message, details: err.details || null },
    meta: {},
  });
}

function ok(res, data, meta = {}, status = 200) {
  return res.status(status).json({ success: true, data, error: null, meta });
}

module.exports = { AppError, errorHandler, ok };
