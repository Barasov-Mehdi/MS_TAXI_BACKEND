/**
 * Lider seçimi: bir neçə server instansiyası (Heroku dyno) işləyəndə fon işləri (dispatch loop, köhnəlmiş sürücü
 * sweep-i, planlaşdırıcılar) YALNIZ BİR instansiyada işləsin. Əks halda N instansiya eyni sorğunu N dəfə edir.
 *
 * Kilid MongoDB-də saxlanılır (ayrıca Redis tələb etmir): { _id: name, owner, expiresAt }.
 * Lider kilidi hər TTL/3-də yeniləyir; instansiya çöksə kilid TTL bitəndə başqasına keçir (default 15 san).
 * Redis yoxdursa tək instansiya rejimi qəbul edilir: hər zaman liderdir (əlavə sorğu yoxdur).
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const redis = require('./redis');

const OWNER = `${process.env.DYNO || 'local'}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
const TTL_MS = Number(process.env.LEADER_TTL_MS || 15000);

const locks = new Map(); // name -> { leader, timer }

function collection() {
  return mongoose.connection.collection('leader_locks');
}

async function tryAcquire(name) {
  const now = new Date();
  try {
    const res = await collection().findOneAndUpdate(
      { _id: name, $or: [{ owner: OWNER }, { expiresAt: { $lt: now } }] },
      { $set: { owner: OWNER, expiresAt: new Date(now.getTime() + TTL_MS) } },
      { upsert: true, returnDocument: 'after' }
    );
    const doc = res && (res.value !== undefined ? res.value : res);
    return !!doc && doc.owner === OWNER;
  } catch (e) {
    // Başqa instansiya kilidi tutub (upsert → dublikat açar)
    if (e && e.code === 11000) return false;
    console.error('[leader] kilid xətası', e && e.message);
    return false;
  }
}

/**
 * Kilid üçün dövri yoxlamanı başladır. Çox instansiya rejimi deyilsə dərhal lider sayılır.
 * @returns {() => boolean} isLeader funksiyası
 */
function campaign(name) {
  if (locks.has(name)) return () => locks.get(name).leader;
  const st = { leader: !redis.enabled() && process.env.FORCE_LEADER_LOCK !== 'true', timer: null };
  locks.set(name, st);
  if (st.leader) return () => true;
  const tick = async () => {
    const was = st.leader;
    st.leader = await tryAcquire(name);
    if (st.leader !== was) console.log(`[leader] ${name}: ${st.leader ? 'bu instansiya liderdir' : 'liderlik itirildi'} (${OWNER})`);
  };
  tick();
  st.timer = setInterval(tick, Math.max(1000, Math.floor(TTL_MS / 3)));
  if (st.timer.unref) st.timer.unref();
  return () => st.leader;
}

async function resignAll() {
  for (const [name, st] of locks) {
    if (st.timer) clearInterval(st.timer);
    if (st.leader && redis.enabled()) {
      // eslint-disable-next-line no-await-in-loop
      await collection().deleteOne({ _id: name, owner: OWNER }).catch(() => {});
    }
    st.leader = false;
  }
  locks.clear();
}

module.exports = { campaign, resignAll, OWNER };
