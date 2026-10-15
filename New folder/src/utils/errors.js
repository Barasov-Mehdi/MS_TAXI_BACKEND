class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeError(err) {
  if (err instanceof AppError) return err;
  if (!err) return new AppError('INTERNAL_ERROR', 'Internal server error', 500);
  // Yanlış formatlı id (məs. "demo") 500 yox, 404 qaytarsın.
  if (err.name === 'CastError') return new AppError('NOT_FOUND', 'Qeyd tapılmadı', 404);
  if (err.name === 'ValidationError') return new AppError('VALIDATION_ERROR', err.message, 400);
  if (err.code === 11000) return new AppError('DUPLICATE', 'Bu qeyd artıq mövcuddur', 409);
  // express.json() xətaları: yanlış JSON / çox böyük gövdə
  if (err.type === 'entity.parse.failed') return new AppError('INVALID_JSON', 'Request body is not valid JSON', 400);
  if (err.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
  // Mongo transaction xətaları (təkrar cəhd tükənib): müştəriyə 500 yox, 503 + təkrar cəhd
  if (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')) {
    return new AppError('TEMPORARILY_UNAVAILABLE', 'Please retry', 503);
  }
  return err;
}

function notFoundHandler(req, res, next) {
  next(new AppError('NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 404));
}

function errorHandler(err, req, res, next) {
  const e = normalizeError(err);
  const status = e.status && Number.isInteger(e.status) ? e.status : 500;
  const code = e.code && typeof e.code === 'string' ? e.code : 'INTERNAL_ERROR';

  // 5xx xətalar əvvəl heç yerdə loglanmırdı: production-da səbəbi tapmaq mümkün deyildi.
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err && err.stack ? err.stack : err);
  }

  if (res.headersSent) return next(err);

  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : e.message;
  res.status(status).json({
    success: false,
    data: null,
    error: { code, message, details: e.details || null },
    meta: {},
  });
}

function ok(res, data, meta = {}, status = 200) {
  return res.status(status).json({ success: true, data, error: null, meta });
}

module.exports = { AppError, errorHandler, notFoundHandler, ok };
