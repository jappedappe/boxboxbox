/* Storrrage offline cache. Only the app's own files are cached;
   calls to Supabase (login, sync, statistics) always go straight to the network. */
const CACHE = 'storrrage-2026-10-23.11';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // Supabase, fonts etc: not touched
  // the app itself: try the network first so updates show up, fall back to the cache offline
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match('./index.html'))));
});

/* Background check (Chrome, installed app): reminders even when Storrrage isn't open. */
const SWT = {
  sv: {m: (n, f) => `${n} saker behöver kollas. Först: ${f}`, w: (n, d) => `${n}: garantin går ut om ${d} dagar`, l: (n, w) => `${w} har fortfarande din ${n}. Dags att be om den tillbaka?`, u: n => `${n} har inte använts på länge. Behålla eller sälja?`, t: 'Storrrage'},
  en: {m: (n, f) => `${n} things need a look. First: ${f}`, w: (n, d) => `${n}: warranty ends in ${d} days`, l: (n, w) => `${w} still has your ${n}. Time to ask for it back?`, u: n => `${n} hasn’t been used in a while. Keep it, or sell it?`, t: 'Storrrage'},
  da: {m: (n, f) => `${n} ting skal tjekkes. Først: ${f}`, w: (n, d) => `${n}: garantien udløber om ${d} dage`, l: (n, w) => `${w} har stadig din ${n}. Tid til at bede om den tilbage?`, u: n => `${n} er ikke brugt længe. Beholde eller sælge?`, t: 'Storrrage'},
  nb: {m: (n, f) => `${n} ting bør sjekkes. Først: ${f}`, w: (n, d) => `${n}: garantien går ut om ${d} dager`, l: (n, w) => `${w} har fortsatt ${n} din. På tide å be om den tilbake?`, u: n => `${n} er ikke brukt på lenge. Beholde eller selge?`, t: 'Storrrage'},
  fi: {m: (n, f) => `${n} asiaa kaipaa huomiota. Ensin: ${f}`, w: (n, d) => `${n}: takuu päättyy ${d} päivän kuluttua`, l: (n, w) => `${w}: ${n} on yhä lainassa. Pyydetäänkö takaisin?`, u: n => `${n} on ollut pitkään käyttämättä.`, t: 'Storrrage'}
};
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('boxes-app'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const get = (db, store, key) => new Promise(res => { try { const q = db.transaction(store).objectStore(store)[key === undefined ? 'getAll' : 'get'](key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch { res(undefined); } });
const put = (db, store, key, val) => new Promise(res => { try { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = res; t.onerror = res; } catch { res(); } });
async function backgroundCheck(){
  const db = await idb();
  if (!(await get(db, 'meta', 'notifOn'))) return;
  const lang = (await get(db, 'meta', 'lang')) || 'sv', T = SWT[lang] || SWT.en;
  const notified = (await get(db, 'meta', 'notified')) || {};
  const boxes = (await get(db, 'boxes')) || [];
  const today = new Date().toISOString().slice(0, 10), days = d => Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 864e5);
  const fresh = it => it.updatedAt && Date.now() - Date.parse(it.updatedAt) < 24 * 3600e3;   // nothing changed in the last 24 h
  const add = (key, body, box, item) => { if (notified[key]) return null; notified[key] = today; return {key, body, box, item}; };
  const out = [];
  for (const b of boxes) for (const it of (b.items || [])){
    if (fresh(it)) continue;
    if (it.warranty){ const d = days(it.warranty); if (d <= 30 && d >= -1){ const a = add(`w:${it.id}:${it.warranty}:${d <= 7 ? 7 : 30}`, T.w(it.name, Math.max(0, d)), b.id, it.id); if (a) out.push(a); } }
    if (it.status === 'On loan' && it.loanDue && it.loanDue <= today){ const a = add(`loan:${it.id}:${it.loanDue}`, T.l(it.name, it.loanTo || '…'), b.id, it.id); if (a) out.push(a); }
    if (it.remindAt && it.remindAt <= today){ const a = add(`due:${it.id}:${it.remindAt}`, T.u(it.name), b.id, it.id); if (a) out.push(a); }
  }
  if (!out.length) return;
  const h = new Date().getHours(); if (h >= 21 || h < 8) return;                      // quiet hours
  if (Date.now() - (+(notified._last || 0)) < 6 * 3600e3) return;                    // at most one per 6 h
  const m = T.m ? T.m(out.length, out[0].body) : out[0].body;
  await self.registration.showNotification(T.t, {body: out.length > 1 ? m : out[0].body, tag: 'storrrage', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', data: out.length > 1 ? {} : {box: out[0].box, item: out[0].item}});
  notified._last = Date.now();
  await put(db, 'meta', 'notified', notified);
}
self.addEventListener('periodicsync', e => { if (e.tag === 'storrrage-check') e.waitUntil(backgroundCheck().catch(() => {})); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const c = list.find(x => x.url.includes(self.registration.scope));
    if (c){ c.postMessage({open: true, box: d.box, item: d.item}); return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
