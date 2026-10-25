/**
 * Bildiriş göndərişi: Firebase və DB mock-lanır, FCM mesajının formasını yoxlayırıq
 * (kanal, click_action, string data, tag, kəsilmə, ölü token təmizliyi).
 */
const mockSend = jest.fn();
const mockUpdateOne = jest.fn(() => ({ catch: () => {} }));
let mockDriverDoc = { _id: 'd1', fcmToken: 'tok-1234567890123456789012345' };

jest.mock('firebase-admin', () => ({
  apps: [],
  app: jest.fn(),
  initializeApp: jest.fn(() => ({})),
  credential: { cert: jest.fn(() => ({})) },
  messaging: jest.fn(() => ({ send: (...a) => mockSend(...a) })),
}));
jest.mock('../src/models', () => ({
  Driver: {
    findById: jest.fn(() => ({ select: () => ({ lean: async () => mockDriverDoc }) })),
    updateOne: (...a) => mockUpdateOne(...a),
  },
}));

const cred = {
  project_id: 'p', client_email: 'a@b.c', private_key: '-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n',
};
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(cred);
const push = require('../src/services/push.service');

beforeEach(() => {
  mockSend.mockReset();
  mockUpdateOne.mockClear();
  mockDriverDoc = { _id: 'd1', fcmToken: 'tok-1234567890123456789012345' };
});

test('çat bildirişi: kanal, click_action, tag və string data', async () => {
  mockSend.mockResolvedValue('id');
  const ok = await push.notifyChatMessage('d1', { orderId: 'o1', messageId: 'm1', senderName: 'Aysel', text: 'Salam' });
  expect(ok).toBe(true);
  const msg = mockSend.mock.calls[0][0];
  expect(msg.notification).toEqual({ title: 'Aysel', body: 'Salam' });
  expect(msg.data).toEqual({ type: 'chat_message', orderId: 'o1', messageId: 'm1' });
  expect(msg.android.priority).toBe('high');
  expect(msg.android.notification).toMatchObject({
    channelId: 'd_chat', sound: 'snd_chat', clickAction: push.CLICK_ACTION, tag: 'chat_o1',
  });
  Object.values(msg.data).forEach((v) => expect(typeof v).toBe('string'));
});

test('uzun mesaj kəsilir', async () => {
  mockSend.mockResolvedValue('id');
  await push.notifyChatMessage('d1', { orderId: 'o1', messageId: 'm1', senderName: 'A', text: 'x'.repeat(500) });
  const body = mockSend.mock.calls[0][0].notification.body;
  expect(body.length).toBeLessThanOrEqual(180);
  expect(body.endsWith('…')).toBe(true);
});

test('balans bildirişi məbləği düzgün göstərir', async () => {
  mockSend.mockResolvedValue('id');
  await push.notifyBalanceChange('d1', { amountMinor: 1000, balanceMinor: 2350, kind: 'TOP_UP' });
  const m = mockSend.mock.calls[0][0];
  expect(m.notification.title).toBe('Balans artırıldı');
  expect(m.notification.body).toContain('+10.00 ₼');
  expect(m.notification.body).toContain('23.50 ₼');
  expect(m.android.notification.channelId).toBe('d_wallet');
  expect(m.android.notification.sound).toBe('snd_wallet');
});

test('token yoxdursa göndərilmir', async () => {
  mockDriverDoc = { _id: 'd1', fcmToken: null };
  expect(await push.notifyOrderCancelled('d1', 'o1', 'CUSTOMER')).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('ölü token təmizlənir', async () => {
  mockSend.mockRejectedValue({ code: 'messaging/registration-token-not-registered' });
  expect(await push.notifyQueuedOrder('d1', 'o1')).toBe(false);
  expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'd1', fcmToken: mockDriverDoc.fcmToken }, { $set: { fcmToken: null } });
});

test('naməlum hesab növü göndərilmir', async () => {
  expect(await push.notifyAccount('d1', 'nope')).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('invalid-argument sağlam tokeni SİLMİR (payload xətası ola bilər)', async () => {
  mockSend.mockRejectedValue({ code: 'messaging/invalid-argument' });
  expect(await push.notifyQueuedOrder('d1', 'o1')).toBe(false);
  expect(mockUpdateOne).not.toHaveBeenCalled();
});

test('başqa Firebase layihəsinin açarı → izahlı diaqnoz', async () => {
  mockSend.mockRejectedValue({ code: 'messaging/mismatched-credential', message: 'SenderId mismatch' });
  const r = await push.testDriver('d1');
  expect(r).toMatchObject({ firebase: true, hasToken: true, sent: false, errorCode: 'messaging/mismatched-credential' });
  expect(r.hint).toMatch(/FIREBASE_DRIVER_SERVICE_ACCOUNT_B64/);
  expect(push.getStatus().driver.lastError.code).toBe('messaging/mismatched-credential');
});

test('test bildirişi uğurlu', async () => {
  mockSend.mockResolvedValue('id');
  const r = await push.testDriver('d1');
  expect(r.sent).toBe(true);
  expect(mockSend.mock.calls[0][0].data).toEqual({ type: 'test' });
  expect(push.getStatus().driver.lastOkAt).toBeTruthy();
});

test('token yoxdursa göndərilmir və səbəb deyilir', async () => {
  mockDriverDoc = { _id: 'd1', fcmToken: null };
  const r = await push.testDriver('d1');
  expect(r).toMatchObject({ firebase: true, hasToken: false, sent: false });
  expect(mockSend).not.toHaveBeenCalled();
});

test('başqa layihənin tokeni: digər açarla təkrar cəhd (layihə köçürmə dövrü)', async () => {
  // Bu testdə hər iki tip eyni (tək) açardan gəlir → digər "client" eynidir, təkrar cəhd olmur, xəta qaytarılır
  mockSend.mockRejectedValue({ code: 'messaging/mismatched-credential' });
  expect(await push.notifyQueuedOrder('d1', 'o1')).toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('hər bildiriş növü öz kanalı və səsi ilə gedir', async () => {
  mockSend.mockResolvedValue('id');
  await push.notifyOrderCancelled('d1', 'o1', 'CUSTOMER');
  await push.notifySupportMessage('d1', { messageId: 'm1', adminName: 'Ofis', text: 'Salam' });
  await push.notifyQueuedOrder('d1', 'o2');
  const n = mockSend.mock.calls.map((c) => c[0].android.notification);
  expect(n[0]).toMatchObject({ channelId: 'd_cancel', sound: 'snd_cancel' });
  expect(n[1]).toMatchObject({ channelId: 'd_support', sound: 'snd_support' });
  expect(n[2]).toMatchObject({ channelId: 'd_trip', sound: 'snd_order' });
});
