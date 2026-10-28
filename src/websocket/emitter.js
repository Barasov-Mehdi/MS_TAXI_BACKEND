let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function emit(room, event, payload) {
  if (!ioRef) return;
  ioRef.to(room).emit(event, payload);
}

/** Sifarişin otağı + sərnişin və sürücünün şəxsi otaqları (eyni soket üçün hadisə bir dəfə çatır). */
function emitToParties(order, event, payload) {
  if (!ioRef || !order) return;
  let target = ioRef.to(`order:${order._id}`);
  if (order.customerId) target = target.to(`customer:${order.customerId}`);
  if (order.driverId) target = target.to(`driver:${order.driverId}`);
  target.emit(event, payload);
}

// Bu hadisələr sifarişin/sürücünün vəziyyətinin dəyişdiyini bildirir - admin panelə də ötürülür
const ORDER_EVENTS = new Set(['order_status_changed', 'order_cancelled', 'trip_completed', 'order_expired', 'driver_assigned']);
const DRIVER_EVENTS = { balance_updated: 'balance', driver_offline: 'offline', documents_updated: 'documents', queued_order_activated: 'order', account_status: 'account' };
const feed = () => require('./adminFeed');
// Sərnişinə push (tətbiq bağlı olanda): bu hadisələr customerNotify-a ötürülür
const CUSTOMER_PUSH_EVENTS = new Set(['order_status_changed', 'trip_completed', 'order_cancelled', 'trip_stopped']);

module.exports = {
  setIo,
  toCustomer: (id, event, payload) => {
    emit(`customer:${id}`, event, payload);
    if (ioRef && CUSTOMER_PUSH_EVENTS.has(event)) require('../services/customerNotify').onCustomerEvent(id, event, payload);
    if (ORDER_EVENTS.has(event) && payload && payload.orderId) feed().orderChanged(payload.orderId);
  },
  toDriver: (id, event, payload) => {
    emit(`driver:${id}`, event, payload);
    if (DRIVER_EVENTS[event]) feed().driverChanged(id, DRIVER_EVENTS[event]);
  },
  toOrder: (id, event, payload) => {
    emit(`order:${id}`, event, payload);
    if (ORDER_EVENTS.has(event)) feed().orderChanged(id);
  },
  // Baş adminlər (admin:operations)
  toAdmin: (event, payload) => emit('admin:operations', event, payload),
  // Baş adminlər + həmin şəhərin regional adminləri
  toAdminCity: (cityId, event, payload) => {
    if (!ioRef) return;
    let t = ioRef.to('admin:operations');
    if (cityId) t = t.to(`admin:city:${cityId}`);
    t.emit(event, payload);
  },
  toParties: emitToParties,
  // Bütün qoşulu müştəri tətbiqlərinə yayım (məs. yeni versiya)
  toCustomers: (event, payload) => emit('customers', event, payload),
  // Sürücülərə yayım: cityId verilibsə yalnız həmin şəhər, yoxsa bütün qoşulu sürücülər
  toDrivers: (cityId, event, payload) => emit(cityId ? `drivers:city:${cityId}` : 'drivers', event, payload),
  // Admin paneli: cityId null → bütün adminlər; dolu → baş adminlər + həmin şəhərin adminləri
  toAdminsFor: (cityId, event, payload) => {
    if (!ioRef) return;
    if (!cityId) ioRef.to('admin:all').emit(event, payload);
    else ioRef.to('admin:operations').to(`admin:city:${cityId}`).emit(event, payload);
  },
  /**
   * Bir hesab = bir cihaz: istifadəçinin `keepSid`-dən fərqli sessiyalı bütün soketlərinə `session_replaced`
   * göndərilir və bağlantı qırılır (köhnə telefon dərhal çıxış edir).
   */
  kickUserSessions: async (role, userId, keepSid, payload = {}) => {
    if (!ioRef) return;
    try {
      const sockets = await ioRef.in(`${String(role).toLowerCase()}:${userId}`).fetchSockets();
      for (const s of sockets) {
        if (keepSid && s.data && s.data.sid === keepSid) continue;
        s.emit('session_replaced', payload);
        // Hadisə çatsın deyə bağlantı bir az sonra qırılır
        setTimeout(() => { try { s.disconnect(true); } catch (_) {} }, 400);
      }
    } catch (e) {
      console.error('[ws] kickUserSessions failed', e && e.message ? e.message : e);
    }
  },
  // Otaqdakı bütün bağlantıları qırır (məs. bloklanmış istifadəçi)
  disconnectRoom: (room) => {
    if (ioRef) ioRef.in(room).disconnectSockets(true);
  },
};
