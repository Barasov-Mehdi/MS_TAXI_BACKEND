const { Message, Order } = require('../models');
const { AppError } = require('../utils/errors');
const realtime = require('../websocket/emitter');

async function sendMessage({ orderId, senderUser, receiverUserId, message, clientMessageId }) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  const existing = await Message.findOne({ orderId, clientMessageId });
  if (existing) return existing;
  const row = await Message.create({
    orderId,
    senderId: senderUser._id,
    receiverId: receiverUserId,
    message,
    clientMessageId,
  });
  realtime.toOrder(orderId, 'incoming_message', {
    messageId: row._id,
    orderId,
    senderId: senderUser._id,
    message,
    createdAt: row.createdAt,
  });
  return row;
}

async function listMessages(orderId) {
  return Message.find({ orderId }).sort({ createdAt: 1 }).lean();
}

module.exports = { sendMessage, listMessages };
