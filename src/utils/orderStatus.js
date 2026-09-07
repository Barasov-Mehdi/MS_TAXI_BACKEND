const OrderStatus = {
  CREATED: 'CREATED',
  SEARCHING_DRIVER: 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ON_THE_WAY: 'DRIVER_ON_THE_WAY',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  TRIP_STARTED: 'TRIP_STARTED',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  RATING_PENDING: 'RATING_PENDING',
  COMPLETED: 'COMPLETED',
  CUSTOMER_CANCELLED: 'CUSTOMER_CANCELLED',
  DRIVER_CANCELLED: 'DRIVER_CANCELLED',
  ADMIN_CANCELLED: 'ADMIN_CANCELLED',
  DISPUTED: 'DISPUTED',
  WAITING_FOR_ADMIN: 'WAITING_FOR_ADMIN',
  QUEUED: 'QUEUED',
  DRIVER_FINISHING_CURRENT_TRIP: 'DRIVER_FINISHING_CURRENT_TRIP',
  DRIVER_HEADING_TO_CUSTOMER: 'DRIVER_HEADING_TO_CUSTOMER',
  EXPIRED: 'EXPIRED',
};

const ALLOWED_TRANSITIONS = {
  [OrderStatus.CREATED]: [OrderStatus.SEARCHING_DRIVER, OrderStatus.CUSTOMER_CANCELLED],
  [OrderStatus.SEARCHING_DRIVER]: [
    OrderStatus.DRIVER_ASSIGNED,
    OrderStatus.QUEUED,
    OrderStatus.DRIVER_FINISHING_CURRENT_TRIP,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.DRIVER_ASSIGNED]: [
    OrderStatus.DRIVER_ON_THE_WAY,
    OrderStatus.DRIVER_CANCELLED,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
  ],
  [OrderStatus.DRIVER_ON_THE_WAY]: [
    OrderStatus.DRIVER_ARRIVED,
    OrderStatus.DRIVER_CANCELLED,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
  ],
  [OrderStatus.DRIVER_ARRIVED]: [
    OrderStatus.TRIP_STARTED,
    OrderStatus.DRIVER_CANCELLED,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
  ],
  [OrderStatus.TRIP_STARTED]: [
    OrderStatus.TRIP_COMPLETED,
    OrderStatus.DRIVER_CANCELLED,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
    OrderStatus.DISPUTED,
  ],
  [OrderStatus.TRIP_COMPLETED]: [OrderStatus.RATING_PENDING, OrderStatus.COMPLETED],
  [OrderStatus.RATING_PENDING]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CUSTOMER_CANCELLED]: [],
  [OrderStatus.DRIVER_CANCELLED]: [],
  [OrderStatus.ADMIN_CANCELLED]: [],
  [OrderStatus.DISPUTED]: [OrderStatus.WAITING_FOR_ADMIN, OrderStatus.COMPLETED, OrderStatus.ADMIN_CANCELLED],
  [OrderStatus.WAITING_FOR_ADMIN]: [OrderStatus.COMPLETED, OrderStatus.ADMIN_CANCELLED],
  [OrderStatus.QUEUED]: [
    OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
    OrderStatus.DRIVER_CANCELLED,
  ],
  [OrderStatus.DRIVER_FINISHING_CURRENT_TRIP]: [
    OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
    OrderStatus.DRIVER_CANCELLED,
  ],
  [OrderStatus.DRIVER_HEADING_TO_CUSTOMER]: [
    OrderStatus.DRIVER_ON_THE_WAY,
    OrderStatus.DRIVER_ARRIVED,
    OrderStatus.DRIVER_CANCELLED,
    OrderStatus.CUSTOMER_CANCELLED,
    OrderStatus.ADMIN_CANCELLED,
  ],
  [OrderStatus.EXPIRED]: [],
};

const TERMINAL = new Set([
  OrderStatus.COMPLETED,
  OrderStatus.CUSTOMER_CANCELLED,
  OrderStatus.DRIVER_CANCELLED,
  OrderStatus.ADMIN_CANCELLED,
  OrderStatus.EXPIRED,
]);

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid order transition ${from} -> ${to}`);
    err.code = 'INVALID_STATE_TRANSITION';
    err.status = 409;
    throw err;
  }
}

function isActive(status) {
  return !TERMINAL.has(status);
}

module.exports = { OrderStatus, ALLOWED_TRANSITIONS, canTransition, assertTransition, isActive };
