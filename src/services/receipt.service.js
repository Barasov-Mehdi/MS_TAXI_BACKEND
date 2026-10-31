/**
 * Səfər qəbzi — PDF (pdfkit). Fayl bazaya və ya diskə YAZILMIR: hər sorğuda sifarişdən yenidən qurulur
 * və birbaşa cavab olaraq göndərilir.
 *
 *   GET /customers/orders/:id/receipt?lang=az → { fileName, mime: 'application/pdf', base64 }
 *
 * Şrift: DejaVu Sans (src/assets/fonts) — Azərbaycan (ə, ş, ğ, ı) və rus hərflərini dəstəkləyir.
 * PDF-ə şriftin yalnız istifadə olunan hərfləri daxil edilir (fayl ~30–60 KB).
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const { OrderStatus } = require('../utils/orderStatus');

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const TZ = 'Asia/Baku';

const BRAND = '#00B14F';
const TEXT = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const SOFT = '#F3F4F6';

const L = {
  az: {
    title: 'Səfər qəbzi', order: 'Sifariş', date: 'Tarix', route: 'Marşrut', from: 'Haradan', to: 'Haraya', stop: 'Dayanacaq',
    trip: 'Səfər', distance: 'Məsafə', duration: 'Müddət', class: 'Sinif', payment: 'Ödəniş',
    fare: 'Qiymət', base: 'Başlanğıc', distFare: 'Məsafə', timeFare: 'Vaxt', stopFare: 'Dayanacaqlar', waiting: 'Gözləmə',
    discount: 'Endirim', total: 'Cəmi', driver: 'Sürücü', name: 'Ad, soyad', car: 'Avtomobil', plate: 'Nömrə',
    stopped: 'Səfər yolda dayandırılıb — gedilən məsafəyə görə hesablanıb', thanks: 'Səfəriniz üçün təşəkkür edirik!',
    km: 'km', min: 'dəq',
    vehicles: { basic: 'Standart', city: 'Şəhərlərarası', premium: 'Premium' },
    payments: { CASH: 'Nağd', CARD: 'Kart', WALLET: 'Pul kisəsi' },
  },
  en: {
    title: 'Trip receipt', order: 'Order', date: 'Date', route: 'Route', from: 'From', to: 'To', stop: 'Stop',
    trip: 'Trip', distance: 'Distance', duration: 'Duration', class: 'Class', payment: 'Payment',
    fare: 'Fare', base: 'Base fare', distFare: 'Distance', timeFare: 'Time', stopFare: 'Stops', waiting: 'Waiting',
    discount: 'Discount', total: 'Total', driver: 'Driver', name: 'Name', car: 'Car', plate: 'Plate',
    stopped: 'Trip was stopped on the way — charged for the distance travelled', thanks: 'Thank you for riding with us!',
    km: 'km', min: 'min',
    vehicles: { basic: 'Standard', city: 'Intercity', premium: 'Premium' },
    payments: { CASH: 'Cash', CARD: 'Card', WALLET: 'Wallet' },
  },
  ru: {
    title: 'Чек поездки', order: 'Заказ', date: 'Дата', route: 'Маршрут', from: 'Откуда', to: 'Куда', stop: 'Остановка',
    trip: 'Поездка', distance: 'Расстояние', duration: 'Время', class: 'Класс', payment: 'Оплата',
    fare: 'Стоимость', base: 'Посадка', distFare: 'Расстояние', timeFare: 'Время', stopFare: 'Остановки', waiting: 'Ожидание',
    discount: 'Скидка', total: 'Итого', driver: 'Водитель', name: 'Имя', car: 'Автомобиль', plate: 'Номер',
    stopped: 'Поездка остановлена в пути — оплата за пройденное расстояние', thanks: 'Спасибо за поездку!',
    km: 'км', min: 'мин',
    vehicles: { basic: 'Стандарт', city: 'Межгород', premium: 'Премиум' },
    payments: { CASH: 'Наличные', CARD: 'Карта', WALLET: 'Кошелёк' },
  },
  tr: {
    title: 'Yolculuk fişi', order: 'Sipariş', date: 'Tarih', route: 'Güzergâh', from: 'Nereden', to: 'Nereye', stop: 'Durak',
    trip: 'Yolculuk', distance: 'Mesafe', duration: 'Süre', class: 'Sınıf', payment: 'Ödeme',
    fare: 'Ücret', base: 'Açılış', distFare: 'Mesafe', timeFare: 'Süre', stopFare: 'Duraklar', waiting: 'Bekleme',
    discount: 'İndirim', total: 'Toplam', driver: 'Sürücü', name: 'Ad soyad', car: 'Araç', plate: 'Plaka',
    stopped: 'Yolculuk yolda durduruldu — gidilen mesafeye göre ücretlendirildi', thanks: 'Yolculuğunuz için teşekkür ederiz!',
    km: 'km', min: 'dk',
    vehicles: { basic: 'Standart', city: 'Şehirlerarası', premium: 'Premium' },
    payments: { CASH: 'Nakit', CARD: 'Kart', WALLET: 'Cüzdan' },
  },
};

const RECEIPT_STATUSES = [OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, OrderStatus.COMPLETED].filter(Boolean);

/** Qəbz yalnız bitmiş (və ya yolda dayandırılıb ödənilmiş) səfər üçün. */
function canHaveReceipt(order) {
  return !!order && (RECEIPT_STATUSES.includes(order.status) || !!(order.stoppedEarly && order.stoppedEarly.at));
}

// DejaVu şriftində ₼ işarəsi yoxdur: "AZN" yazılır
const money = (minor) => `${(Number(minor || 0) / 100).toFixed(2).replace('.', ',')} AZN`;
const shortId = (order) => String(order._id || '').slice(-6).toUpperCase();
const vehicleKey = (v) => (v === 'bolt' ? 'premium' : ['basic', 'city', 'premium'].includes(v) ? v : 'basic');

function formatDate(value, lang) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const locale = { az: 'az-Latn-AZ', ru: 'ru-RU', tr: 'tr-TR', en: 'en-GB' }[lang] || 'az-Latn-AZ';
  try {
    // Hissə-hissə yığılır ki, bütün dillərdə eyni görünsün: "31 oktyabr 2026, 23:45"
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
  } catch (_) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Sürücü nömrəsi: "07BC007" → "07-BC-007" (tətbiqdəki ilə eyni). */
function formatPlate(p) {
  const s = String(p || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = /^(\d{2})([A-Z]{2})(\d{3})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || '').toUpperCase();
}

/**
 * PDF-i yaddaşda qurur → Buffer.
 * order: Order sənədi / obyekt;  driver: customer.routes publicDriver() nəticəsi (və ya null)
 */
function buildReceiptPdf({ order, driver, lang = 'az' }) {
  const t = L[lang] || L.az;
  const o = order && typeof order.toObject === 'function' ? order.toObject() : order || {};
  const snap = o.pricingSnapshot || {};
  const stops = Array.isArray(o.stops) ? o.stops : [];
  const dest = stops.length ? stops[stops.length - 1] : null;
  const addr = (s) => (s && (s.address || s.label)) || '';
  const total = o.stoppedEarly && o.stoppedEarly.chargedMinor != null ? o.stoppedEarly.chargedMinor : snap.finalPriceMinor;

  const W = 360; // dar "çek" formatı (pt)
  const PAGE_H = 1100;
  const M = 24;
  const IW = W - M * 2;

  return new Promise((resolve, reject) => {
    // Hündürlük: əvvəl təxmini, səhifə məzmuna görə uzun saxlanılır (bir səhifə)
    const doc = new PDFDocument({ size: [W, PAGE_H], margin: M, info: { Title: `${t.title} #${shortId(o)}`, Author: 'Baras', Creator: 'Baras' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('R', FONT);
    doc.registerFont('B', FONT_BOLD);

    // ---- Başlıq zolağı
    doc.rect(0, 0, W, 86).fill(BRAND);
    doc.fill('#FFFFFF').font('B').fontSize(26).text('BARAS', M, 22, { width: IW, characterSpacing: 2 });
    doc.font('R').fontSize(11).fillOpacity(0.92).text(t.title, M, 54, { width: IW });
    doc.fillOpacity(1);

    let y = 104;
    const row = (label, value, opts = {}) => {
      if (value == null || value === '') return;
      const size = opts.size || 10.5;
      doc.font('R').fontSize(size).fill(MUTED).text(label, M, y, { width: IW * 0.45 });
      doc.font(opts.bold ? 'B' : 'R').fontSize(size).fill(opts.color || TEXT);
      const h = doc.heightOfString(String(value), { width: IW * 0.55, align: 'right' });
      doc.text(String(value), M + IW * 0.45, y, { width: IW * 0.55, align: 'right' });
      y += Math.max(h, size + 3) + 6;
    };
    const section = (title) => {
      y += 4;
      doc.font('B').fontSize(9).fill(MUTED).text(title.toUpperCase(), M, y, { width: IW, characterSpacing: 0.6 });
      y += 16;
    };
    const divider = () => {
      y += 4;
      doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.8).strokeColor(LINE).stroke();
      y += 10;
    };

    row(t.order, `#${shortId(o)}`, { bold: true });
    row(t.date, formatDate(o.completedAt || (o.stoppedEarly && o.stoppedEarly.at) || o.startedAt || o.createdAt, lang));
    divider();

    // ---- Marşrut (nöqtələr və xətt)
    section(t.route);
    const points = [
      { label: t.from, text: o.pickupAddress || o.pickupLabel || '', color: BRAND },
      ...stops.slice(0, -1).map((s, i) => ({ label: `${t.stop} ${i + 1}`, text: addr(s), color: '#F59E0B' })),
      ...(dest ? [{ label: t.to, text: addr(dest), color: '#EF4444' }] : []),
    ];
    points.forEach((p, i) => {
      const startY = y;
      doc.font('R').fontSize(8.5).fill(MUTED).text(p.label, M + 18, y, { width: IW - 18 });
      y += 11;
      doc.font('B').fontSize(10.5).fill(TEXT).text(p.text || '—', M + 18, y, { width: IW - 18 });
      y += doc.heightOfString(p.text || '—', { width: IW - 18 }) + 8;
      doc.circle(M + 5, startY + 9, 4).fill(p.color);
      if (i < points.length - 1) {
        doc.moveTo(M + 5, startY + 15).lineTo(M + 5, y + 4).lineWidth(1.2).dash(2, { space: 2 }).strokeColor('#D1D5DB').stroke().undash();
      }
    });
    divider();

    // ---- Səfər məlumatı
    section(t.trip);
    const meters = o.stoppedEarly && o.stoppedEarly.traveledMeters ? o.stoppedEarly.traveledMeters : o.tripMeters || o.distanceMeters;
    if (meters) row(t.distance, `${(meters / 1000).toFixed(1).replace('.', ',')} ${t.km}`);
    if (o.durationMin) row(t.duration, `${Math.max(1, Math.round(o.durationMin))} ${t.min}`);
    row(t.class, t.vehicles[vehicleKey(o.vehicleType || snap.vehicleType)]);
    row(t.payment, t.payments[o.paymentMethod] || t.payments.CASH);
    divider();

    // ---- Qiymətin tərkibi
    section(t.fare);
    const parts = [
      [t.base, snap.baseFareMinor],
      [t.distFare, snap.distanceFareMinor],
      [t.timeFare, snap.timeFareMinor],
      [t.stopFare, snap.stopFareMinor],
      [t.waiting, snap.waitingFareMinor],
    ].filter(([, v]) => Number(v) > 0);
    parts.forEach(([label, v]) => row(label, money(v)));
    if (Number(snap.discountMinor) > 0) {
      row(o.promoCode ? `${t.discount} (${o.promoCode})` : t.discount, `−${money(snap.discountMinor)}`, { color: BRAND });
    }
    if (o.stoppedEarly && o.stoppedEarly.at) {
      doc.font('R').fontSize(8.5).fill('#B45309').text(t.stopped, M, y, { width: IW });
      y += doc.heightOfString(t.stopped, { width: IW }) + 6;
    }

    // Cəmi — vurğulanmış qutu
    y += 4;
    doc.roundedRect(M, y, IW, 44, 10).fill(SOFT);
    doc.font('B').fontSize(12).fill(TEXT).text(t.total, M + 14, y + 14, { width: IW / 2 });
    doc.font('B').fontSize(18).fill(BRAND).text(money(total), M + IW / 2, y + 10, { width: IW / 2 - 14, align: 'right' });
    y += 56;

    // ---- Sürücü
    if (driver) {
      divider();
      section(t.driver);
      const name = [driver.firstName, driver.lastName].filter(Boolean).join(' ');
      const v = driver.vehicle || {};
      const car = [[v.make, v.model].filter(Boolean).join(' '), v.color].filter(Boolean).join(', ');
      row(t.name, name);
      row(t.car, car);
      row(t.plate, v.plateNumber ? formatPlate(v.plateNumber) : '', { bold: true });
    }

    // ---- Alt hissə
    y += 10;
    doc.font('B').fontSize(11).fill(BRAND).text(t.thanks, M, y, { width: IW, align: 'center' });
    y += 20;

    // Səhifəni məzmun hündürlüyünə qədər qısalt (bir səhifəlik "çek").
    // pdfkit koordinatları yuxarıdan hesablayır (PDF-də y = PAGE_H - y), ona görə görünən sahə yuxarı hissədir.
    const height = Math.min(PAGE_H, Math.max(420, Math.ceil(y + M)));
    doc.page.dictionary.data.MediaBox = [0, PAGE_H - height, W, PAGE_H];
    doc.end();
  });
}

function receiptFileName(order) {
  return `Baras-qebz-${shortId(order)}`;
}

module.exports = { buildReceiptPdf, canHaveReceipt, receiptFileName, formatPlate, L };
