const { Message, Order, Customer, Driver } = require('../models');
const { AppError } = require('../utils/errors');
const realtime = require('../websocket/emitter');

const MAX_MESSAGE_LENGTH = 1000;

/**
 * Sifarişin iki tərəfi: sərnişin və təyin olunmuş sürücü (User id-ləri ilə).
 * Yalnız bu iki nəfər sifariş çatına yaza/oxuya bilər.
 */
async function resolveParties(order) {
  const [customer, driver] = await Promise.all([
    Customer.findById(order.customerId).select('userId').lean(),
    order.driverId ? Driver.findById(order.driverId).select('userId').lean() : null,
  ]);
  return {
    customerUserId: customer ? String(customer.userId) : null,
    driverUserId: driver ? String(driver.userId) : null,
  };
}

/** İstifadəçi sifarişin iştirakçısı deyilsə 403 atır; iştirakçıdırsa tərəfləri qaytarır. */
async function assertParticipant(orderId, user) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  const parties = await resolveParties(order);
  const me = String(user._id);
  if (me !== parties.customerUserId && me !== parties.driverUserId) {
    throw new AppError('FORBIDDEN', 'Bu sifarişin çatına icazəniz yoxdur', 403);
  }
  return { order, ...parties };
}

/**
 * Mesaj göndərir. Göndərən sifarişin iştirakçısı olmalıdır; alıcı HƏMİŞƏ serverdə təyin olunur
 * (client-in göndərdiyi receiverId nəzərə alınmır - başqasının adından/başqasına yazmaq olmaz).
 */
async function sendMessage({ orderId, senderUser, message, clientMessageId }) {
  const text = String(message == null ? '' : message).trim();
  if (!text) throw new AppError('VALIDATION_ERROR', 'Mesaj boş ola bilməz', 400);
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new AppError('VALIDATION_ERROR', `Mesaj ən çox ${MAX_MESSAGE_LENGTH} simvol ola bilər`, 400);
  }

  const { order, customerUserId, driverUserId } = await assertParticipant(orderId, senderUser);
  if (!driverUserId) throw new AppError('NO_DRIVER', 'Sürücü təyin olunmayıb', 409);
  const me = String(senderUser._id);
  const receiverId = me === customerUserId ? driverUserId : customerUserId;

  const cid = String(clientMessageId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 80);
  const existing = await Message.findOne({ orderId: order._id, clientMessageId: cid });
  if (existing) return existing;

  let row;
  try {
    row = await Message.create({
      orderId: order._id,
      senderId: senderUser._id,
      receiverId,
      message: text,
      clientMessageId: cid,
    });
  } catch (e) {
    // Eyni clientMessageId ilə paralel təkrar: mövcud mesaj qaytarılır.
    if (e && e.code === 11000) return Message.findOne({ orderId: order._id, clientMessageId: cid });
    throw e;
  }

  // Sifariş otağı + hər iki tərəfin şəxsi otağı: tərəf `join_order` etməyibsə (məs. sürücü tətbiqi
  // yenicə açılıb) belə mesajı alır. Socket.IO eyni soketə iki otaqdan olsa da bir dəfə çatdırır.
  realtime.toParties(order, 'incoming_message', {
    messageId: row._id,
    orderId: order._id,
    senderId: senderUser._id,
    receiverId,
    message: text,
    clientMessageId: cid,
    createdAt: row.createdAt,
  });
  return row;
}

async function listMessages(orderId, user) {
  const { order } = await assertParticipant(orderId, user);
  return Message.find({ orderId: order._id }).sort({ createdAt: 1 }).limit(500).lean();
}

module.exports = { sendMessage, listMessages, assertParticipant, MAX_MESSAGE_LENGTH };
