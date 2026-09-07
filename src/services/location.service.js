const { Driver, Customer } = require('../models');
const { getSettings } = require('./settings.service');
const { point } = require('../utils/geo');
const realtime = require('../websocket/emitter');
const { Order } = require('../models');
const matchingService = require('./matching.service');

async function updateDriverLocation(driver, payload) {
  const { latitude, longitude, accuracy, heading, speed, timestamp } = payload;
  const ts = timestamp ? new Date(timestamp) : new Date();
  if (driver.locationMeta && driver.locationMeta.timestamp && ts < driver.locationMeta.timestamp) {
    return driver;
  }
  const settings = await getSettings();
  if (accuracy != null && accuracy > (settings.maxLocationAccuracyMeters || 80) * 3) {
    return driver;
  }
  driver.location = point(longitude, latitude);
  driver.locationMeta = { accuracy, heading, speed, timestamp: ts };
  driver.locationUpdatedAt = new Date();
  await driver.save();

  if (driver.currentOrderId) {
    const order = await Order.findById(driver.currentOrderId);
    if (order) {
      realtime.toCustomer(order.customerId, 'driver_location_updated', {
        orderId: order._id,
        latitude,
        longitude,
        heading,
        speed,
        timestamp: ts,
      });
      realtime.toOrder(order._id, 'driver_location_updated', {
        latitude, longitude, heading, speed, timestamp: ts,
      });
    }
    const dist = await matchingService.distanceToCurrentDestination(driver);
    if (dist != null && dist <= settings.orderQueueActivationDistance) {
      realtime.toDriver(driver._id, 'queue_window_open', { distanceToDestinationMeters: dist });
    }
  }
  return driver;
}

async function updateCustomerLocation(customer, payload) {
  const { latitude, longitude } = payload;
  customer.location = point(longitude, latitude);
  customer.locationUpdatedAt = new Date();
  await customer.save();
  return customer;
}

module.exports = { updateDriverLocation, updateCustomerLocation };
