/**
 * Yük testi (k6): eyni anda çoxlu sərnişin tətbiqi — profil, xəritə məlumatı, qiymət sorğusu, tarixçə.
 *
 *   node scripts/loadtest/seed-users.js > tokens.json        (staging)
 *   k6 run -e BASE_URL=https://<staging>.herokuapp.com -e VUS=2000 scripts/loadtest/k6-customers.js
 *
 * Hədəflər (thresholds): p95 < 500 ms, xəta < 1%. Sifariş YARADILMIR (sürücülər narahat olmasın).
 * Sürücü konumu / socket yükü üçün: k6 xk6-websockets və ya Artillery socket.io sınağı ayrıca.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const tokens = new SharedArray('tokens', () => JSON.parse(open('../../tokens.json')));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || 500);

export const options = {
  scenarios: {
    customers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: VUS },
        { duration: '5m', target: VUS },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

// Zaqatala ətrafı təsadüfi nöqtələr
const rnd = (a, b) => a + Math.random() * (b - a);
const point = () => ({ lat: rnd(41.60, 41.66), lng: rnd(46.60, 46.68) });

export default function () {
  const t = tokens[(__VU - 1) % tokens.length].token;
  const h = { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } };

  const me = http.get(`${BASE}/customers/me`, h);
  check(me, { 'me 200': (r) => r.status === 200 });

  const a = point();
  const b = point();
  const q = http.post(`${BASE}/customers/orders/quote`, JSON.stringify({ pickup: a, stops: [b] }), h);
  check(q, { 'quote 200': (r) => r.status === 200 });

  const act = http.get(`${BASE}/customers/orders/active`, h);
  check(act, { 'active 200': (r) => r.status === 200 });

  if (Math.random() < 0.3) {
    const hist = http.get(`${BASE}/customers/orders?limit=20`, h);
    check(hist, { 'history 200': (r) => r.status === 200 });
  }
  sleep(rnd(3, 8));
}
