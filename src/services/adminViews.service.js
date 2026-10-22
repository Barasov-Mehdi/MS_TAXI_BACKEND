const mongoose = require('mongoose');
const { Driver, Customer, User, Vehicle, City, Rating } = require('../models');

/** Admin paneli üçün siyahıları oxunaqlı edən köməkçilər (ad, telefon, şəhər, nömrə nişanı). */

const name = (u) => [u && u.firstName, u && u.lastName].filter(Boolean).join(' ').trim() || (u && u.username) || '';

/** driverId → { name, phone, cityId, cityName, plate } */
async function driverInfoMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const drivers = await Driver.find({ _id: { $in: uniq } })
    .select('userId cityId vehicleId isVerified isActive isOnline ratingAvg deletedAt')
    .populate('userId', 'firstName lastName phone deletedPhone')
    .lean();
  const cityIds = [...new Set(drivers.map((d) => d.cityId).filter(Boolean).map(String))];
  const cities = cityIds.length ? await City.find({ _id: { $in: cityIds } }).select('name').lean() : [];
  const cityName = new Map(cities.map((c) => [String(c._id), c.name]));
  const vehicles = await Vehicle.find({ driverId: { $in: uniq } }).select('driverId plateNumber make model color').lean();
  const vehicleBy = new Map(vehicles.map((v) => [String(v.driverId), v]));
  return new Map(
    drivers.map((d) => {
      const u = d.userId || {};
      const v = vehicleBy.get(String(d._id));
      return [
        String(d._id),
        {
          _id: d._id,
          name: name(u),
          phone: u.deletedPhone || u.phone || '',
          cityId: d.cityId || null,
          cityName: d.cityId ? cityName.get(String(d.cityId)) || '' : '',
          plate: v ? String(v.plateNumber || '').replace(/#del\d+$/, '') : '',
          car: v ? [v.make, v.model, v.color].filter(Boolean).join(' ') : '',
          ratingAvg: d.ratingAvg,
          isVerified: d.isVerified,
          isActive: d.isActive,
          isOnline: d.isOnline,
          deleted: !!d.deletedAt,
        },
      ];
    })
  );
}

/** customerId → { name, phone } */
async function customerInfoMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const customers = await Customer.find({ _id: { $in: uniq } }).populate('userId', 'firstName lastName username phone').lean();
  return new Map(customers.map((c) => [String(c._id), { _id: c._id, name: name(c.userId), phone: (c.userId && c.userId.phone) || '' }]));
}

/** Sifariş siyahısına sürücü/müştəri adları və reytinq əlavə edir. */
async function enrichOrders(orders) {
  const list = orders.map((o) => (typeof o.toObject === 'function' ? o.toObject() : o));
  const [drivers, customers, ratings] = await Promise.all([
    driverInfoMap(list.map((o) => o.driverId)),
    customerInfoMap(list.map((o) => o.customerId)),
    Rating.find({ orderId: { $in: list.map((o) => o._id) } }).select('orderId score comment').lean(),
  ]);
  const ratingBy = new Map(ratings.map((r) => [String(r.orderId), r]));
  return list.map((o) => ({
    ...o,
    driver: o.driverId ? drivers.get(String(o.driverId)) || null : null,
    customer: customers.get(String(o.customerId)) || null,
    rating: ratingBy.get(String(o._id)) || null,
  }));
}

/** ?page=&limit= → { skip, limit, page } */
function paging(query, def = 25, max = 100) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || def, 1), max);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

/** Gün başlanğıcı (Bakı vaxtı, UTC+4). */
function dayStartBaku(d = new Date()) {
  const offset = 4 * 60 * 60 * 1000;
  const local = new Date(d.getTime() + offset);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offset);
}

const oid = (v) => (v && mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

module.exports = { driverInfoMap, customerInfoMap, enrichOrders, paging, dayStartBaku, oid, displayName: name };
