/**
 * Müştərinin ünvanları və planlı sifarişləri.
 *   /customers/places           GET, POST       ünvanlar (Ev, İş, digər)
 *   /customers/places/:id       PATCH, DELETE
 *   /customers/places/:id/use   POST            ünvan istifadə olundu (axtarışda yuxarı çıxır)
 *   /customers/scheduled-rides      GET, POST   planlı (avtomatik) sifarişlər
 *   /customers/scheduled-rides/:id  PATCH, DELETE
 */
const express = require('express');
const mongoose = require('mongoose');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const places = require('../services/savedPlace.service');
const scheduled = require('../services/scheduledRide.service');

function checkId(code, message) {
  return (req, res, next, id) => (mongoose.isValidObjectId(id) ? next() : next(new AppError(code, message, 404)));
}

const placesRouter = express.Router();
placesRouter.use(authenticate, requireRoles('CUSTOMER'));
placesRouter.param('id', checkId('PLACE_NOT_FOUND', 'Ünvan tapılmadı'));

placesRouter.get('/', async (req, res, next) => {
  try {
    ok(res, { places: await places.list(req.customer._id) });
  } catch (e) { next(e); }
});
placesRouter.post('/', async (req, res, next) => {
  try {
    ok(res, { place: await places.create(req.customer._id, req.body || {}) }, {}, 201);
  } catch (e) { next(e); }
});
placesRouter.patch('/:id', async (req, res, next) => {
  try {
    ok(res, { place: await places.update(req.customer._id, req.params.id, req.body || {}) });
  } catch (e) { next(e); }
});
placesRouter.delete('/:id', async (req, res, next) => {
  try {
    ok(res, await places.remove(req.customer._id, req.params.id));
  } catch (e) { next(e); }
});
placesRouter.post('/:id/use', async (req, res, next) => {
  try {
    ok(res, await places.touch(req.customer._id, req.params.id));
  } catch (e) { next(e); }
});

const scheduledRouter = express.Router();
scheduledRouter.use(authenticate, requireRoles('CUSTOMER'));
scheduledRouter.param('id', checkId('SCHEDULE_NOT_FOUND', 'Plan tapılmadı'));

scheduledRouter.get('/', async (req, res, next) => {
  try {
    ok(res, { rides: await scheduled.list(req.customer._id) });
  } catch (e) { next(e); }
});
scheduledRouter.post('/', async (req, res, next) => {
  try {
    ok(res, { ride: await scheduled.create({ customer: req.customer, user: req.user }, req.body || {}) }, {}, 201);
  } catch (e) { next(e); }
});
scheduledRouter.patch('/:id', async (req, res, next) => {
  try {
    ok(res, { ride: await scheduled.update({ customer: req.customer }, req.params.id, req.body || {}) });
  } catch (e) { next(e); }
});
scheduledRouter.delete('/:id', async (req, res, next) => {
  try {
    ok(res, await scheduled.remove({ customer: req.customer }, req.params.id));
  } catch (e) { next(e); }
});

module.exports = { placesRouter, scheduledRouter };
