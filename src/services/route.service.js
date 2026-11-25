/**
 * Serverdə marşrut məsafəsi (Mapbox Directions).
 *
 * Problem: əvvəl qiymət yalnız müştəri tətbiqinin göndərdiyi km-ə və ya düz xəttə (× 1.25) görə hesablanırdı.
 * Dağ/çay olan bölgələrdə (Zaqatala, Qax, Balakən) yol düz xəttdən 3 dəfədən çox uzun ola bilir: tətbiqin km-i
 * "inandırıcı deyil" sayılıb atılır, qiymət düz xəttə görə çıxırdı → ekranda 9 km, qiymət 3 km-lik.
 *
 * İndi: MAPBOX_TOKEN (server açarı) varsa, server özü yolu hesablayır və bu, əsas mənbədir.
 * Tətbiqin göndərdiyi dəyər serverinkinə ±15% yaxındırsa ondan istifadə olunur (ekranda görünən km = qiymətin km-i).
 * Açar yoxdursa və ya Mapbox cavab vermirsə - pricing.resolveTripMetrics (köhnə yoxlama) işləyir.
 */
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

const token = () => process.env.MAPBOX_TOKEN || process.env.MAPBOX_SERVER_TOKEN || '';
const enabled = () => !!token() && process.env.SERVER_ROUTING !== 'false';
const timeoutMs = () => Number(process.env.ROUTE_TIMEOUT_MS || 4000);

const r5 = (n) => Math.round(Number(n) * 1e5) / 1e5;
const keyOf = (points) => points.map((p) => `${r5(p.lat)},${r5(p.lng)}`).join('|');

/**
 * @param {Array<{lat:number,lng:number}>} points ən azı 2, ən çox 25 nöqtə
 * @returns {Promise<{distanceMeters:number,durationMin:number}|null>} null - hesablana bilmədi
 */
async function routeMetrics(points) {
  if (!enabled() || !Array.isArray(points) || points.length < 2 || points.length > 25) return null;
  const key = keyOf(points);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const coords = points.map((p) => `${r5(p.lng)},${r5(p.lat)}`).join(';');
  const url = `${DIRECTIONS_URL}/driving/${coords}?overview=false&steps=false&access_token=${encodeURIComponent(token())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json && json.routes && json.routes[0];
    if (!r || !Number.isFinite(r.distance)) return null;
    const value = { distanceMeters: Math.round(r.distance), durationMin: Math.round((r.duration / 60) * 10) / 10 };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { routeMetrics, enabled, clearCache };
