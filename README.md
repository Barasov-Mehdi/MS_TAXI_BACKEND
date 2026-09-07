# Taxi Backend (Node.js + Express + MongoDB)

Production-oriented taxi backend: JWT auth, geospatial driver matching (MongoDB `2dsphere`), integer AZN/qəpik money, order state machine, queued orders (100m window), wallets, promo, Socket.IO, background worker. Commission is 13% of fare, or 15% when the driver's current ratingAvg is below 3.

## Stack

- Node.js 20 + Express
- MongoDB 7 (GeoJSON + 2dsphere instead of PostGIS)
- Socket.IO
- Joi, JWT access + refresh, bcrypt, Helmet, rate limit

MongoDB was chosen because you requested Express + MongoDB. Spatial queries use `$nearSphere` + application-level radius/score filters. Money is always integer qəpik.

## Quick start

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run seed
npm run dev
```

Admin after seed: `+994500000000` / `Admin123!`

## REST (standard envelope)

Success: `{ success, data, error: null, meta }`  
Error: `{ success: false, data: null, error: { code, message }, meta }`

### Auth
- POST `/auth/register` `{ role, phone, password, firstName, lastName }`
- POST `/auth/login` `{ phone, password }`
- POST `/auth/refresh` `{ refreshToken }`
- POST `/auth/logout` `{ refreshToken }`
- POST `/auth/verify-phone` `{ code }` Bearer
- POST `/auth/forgot-password` `{ phone }`
- POST `/auth/reset-password` `{ phone, code, password }`

### Customer (`Authorization: Bearer`, role CUSTOMER)
- GET/PATCH `/customers/me`
- POST `/customers/location` `{ latitude, longitude }`
- POST `/customers/orders` `{ pickupLat, pickupLng, destLat, destLng, promoCode, paymentMethod }`
- GET `/customers/orders` | GET `/customers/orders/:id`
- POST `/customers/orders/:id/cancel|rating|complaints|issues|messages`

### Driver
- GET/PATCH `/drivers/me`
- POST `/drivers/online` `/drivers/offline` `/drivers/location`
- PATCH `/drivers/radius` `{ radiusMeters }`
- POST `/drivers/vehicle`
- GET `/drivers/orders`
- POST `/drivers/orders/:id/accept|reject|arrive|start|complete|cancel|issues`
- GET `/drivers/wallet` `/drivers/wallet/transactions`

### Admin
- Orders, reassign, cancel
- Drivers/customers patch
- Complaints/issues
- Pricing rules + promo codes
- Settings
- Wallet top-up / adjustment
- Audit logs

Send `Idempotency-Key` header on accept/complete/top-up.

## Order states

CREATED → SEARCHING_DRIVER → DRIVER_ASSIGNED / QUEUED / DRIVER_FINISHING_CURRENT_TRIP → DRIVER_ON_THE_WAY / DRIVER_HEADING_TO_CUSTOMER → DRIVER_ARRIVED → TRIP_STARTED → TRIP_COMPLETED → RATING_PENDING → COMPLETED

Cancels: CUSTOMER_CANCELLED, DRIVER_CANCELLED, ADMIN_CANCELLED. Also EXPIRED, DISPUTED.

Illegal transitions throw `INVALID_STATE_TRANSITION`.

## Matching + 100m queue

Eligible driver: online, active, verified, fresh GPS, accuracy OK, wallet ≥ min, radius contains pickup.

If driver has `currentOrderId` in `TRIP_STARTED`, they only match when `distance(driver, current destination) ≤ orderQueueActivationDistance` (default 100m, settings). Accepted order becomes `QUEUED`. On complete, transaction: current → completed + commission; first queued → `DRIVER_HEADING_TO_CUSTOMER`.

## Money

Store qəpik only. Example commission default 11 qəpik FIXED. Low rating fee default 15 if score < 3. All admin-configurable via `/admin/settings`.

## WebSocket

Auth: `io({ auth: { token } })`.

Rooms: `customer:{id}`, `driver:{id}`, `order:{id}`, `admin:operations`.

Client events: `join_order`, `driver_location_update`, `customer_location_update`, `message_send`.

Server events: `new_order`, `order_taken_by_other_driver`, `driver_assigned`, `driver_location_updated`, `order_status_changed`, `queued_order`, `queued_order_activated`, `incoming_message`, `trip_completed`, `order_cancelled`, `balance_updated`.

## Worker

`npm run worker` expires searching orders and marks stale GPS drivers offline.

## Tests

`npm test` — money, state machine, band pricing (3.4 km → 240 qəpik).
