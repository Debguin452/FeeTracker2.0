'use strict';

const CACHE_VERSION = 'ft-v16';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './connect.html',
  './css/app.css',
  './js/app.js',
  './js/pwa.js',
  './js/theme.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const CDN_PATTERNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
];

const BYPASS_PATTERNS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'fcmregistrations.googleapis.com',
  'firebase.googleapis.com',
  'firebasestorage.googleapis.com',
  'gstatic.com/firebasejs',
];

// Same-origin paths that must always hit the network — never cache config or auth proxy
const API_BYPASS = ['/api/', '/__/auth/'];

const MAX_RUNTIME_ENTRIES = 80;
const MAX_RUNTIME_AGE_MS  = 7 * 24 * 60 * 60 * 1000;
const FLUSH_THROTTLE_MS   = 30_000;

const IDB_NAME    = 'fee-tracker-cache';
const IDB_VERSION = 4;

let _idb = null;

function openIDB() {
  if (_idb) return Promise.resolve(_idb);

  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      const old = ev.oldVersion;

      if (!db.objectStoreNames.contains('kv'))
        db.createObjectStore('kv');

      if (!db.objectStoreNames.contains('batches_detail'))
        db.createObjectStore('batches_detail');

      if (!db.objectStoreNames.contains('sw_meta'))
        db.createObjectStore('sw_meta');

      if (old < 3) {
        if (!db.objectStoreNames.contains('sw_queue')) {
          const qs = db.createObjectStore('sw_queue', {
            keyPath: 'id',
            autoIncrement: true
          });

          qs.createIndex('by_ts', 'ts');
          qs.createIndex('by_uid', 'uid');
        }
      }
    };

    req.onsuccess = ev => {
      _idb = ev.target.result;
      res(_idb);
    };

    req.onerror = ev => {
      rej(ev.target.error);
    };
  });
}


async function idbGet(store, key) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror   = () => rej(r.error);
    });
  } catch { return null; }
}

async function idbPut(store, key, value) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function idbGetAll(store) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => rej(r.error);
    });
  } catch { return []; }
}

async function idbDelete(store, key) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function idbClear(store) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).clear();
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function enqueueRequest(uid, request) {
  let body = '';
  try { body = await request.clone().text(); } catch {}
  const headers = {};
  try { request.headers.forEach((v, k) => { headers[k] = v; }); } catch {}
  await openIDB();
  const db = await openIDB();
  return new Promise((res, rej) => {
    const r = db.transaction('sw_queue', 'readwrite').objectStore('sw_queue').add({
      uid, ts: Date.now(), method: request.method,
      url: request.url, body, headers, retries: 0,
    });
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

let _lastFlush = 0;

async function flushQueue() {
  const now = Date.now();
  if (now - _lastFlush < FLUSH_THROTTLE_MS) return;
  _lastFlush = now;
  const items = await idbGetAll('sw_queue');
  if (!items.length) return;
  let flushed = 0;
  for (const item of items.sort((a, b) => a.ts - b.ts)) {
    try {
      const res = await fetch(item.url, {
        method:  item.method,
        headers: item.headers,
        body:    ['GET','HEAD'].includes(item.method) ? undefined : item.body,
      });
      if (res.ok || res.status === 409) {
        await idbDelete('sw_queue', item.id);
        flushed++;
      } else if (res.status >= 400 && res.status < 500) {
        await idbDelete('sw_queue', item.id);
      } else {
        if (item.retries >= 4) {
          await idbDelete('sw_queue', item.id);
        } else {
          const db = await openIDB();
          await new Promise(done => {
            const tx = db.transaction('sw_queue', 'readwrite');
            tx.objectStore('sw_queue').put({ ...item, retries: item.retries + 1 });
            tx.oncomplete = done;
          });
        }
      }
    } catch { break; }
  }
  if (flushed > 0) await broadcastToClients({ type: 'BG_SYNC_TRIGGER', flushed });
}

async function broadcastToClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(c => c.postMessage(msg));
}

async function stampCacheEntry(url) {
  const meta = (await idbGet('sw_meta', 'rt_ts')) || {};
  meta[url]  = Date.now();
  await idbPut('sw_meta', 'rt_ts', meta);
}

async function trimRuntimeCache() {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    const keys  = await cache.keys();
    const meta  = (await idbGet('sw_meta', 'rt_ts')) || {};
    const now   = Date.now();
    for (const req of keys) {
      if (meta[req.url] && (now - meta[req.url]) > MAX_RUNTIME_AGE_MS) {
        await cache.delete(req);
        delete meta[req.url];
      }
    }
    const remaining = await cache.keys();
    if (remaining.length > MAX_RUNTIME_ENTRIES) {
      const sorted = remaining.map(r => ({ r, ts: meta[r.url] || 0 })).sort((a, b) => a.ts - b.ts);
      for (const { r } of sorted.slice(0, remaining.length - MAX_RUNTIME_ENTRIES)) {
        await cache.delete(r);
        delete meta[r.url];
      }
    }
    await idbPut('sw_meta', 'rt_ts', meta);
  } catch {}
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await openIDB().catch(() => {});
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(
      SHELL_ASSETS.map(url =>
        fetch(new Request(url, { cache: 'reload' }))
          .then(r => r.ok ? cache.put(url, r) : null)
          .catch(() => {})
      )
    );
    await idbPut('sw_meta', 'version',    CACHE_VERSION);
    await idbPut('sw_meta', 'install_ts', Date.now());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const allNames = await caches.keys();
    await Promise.all(allNames.filter(n => !n.startsWith(CACHE_VERSION)).map(n => caches.delete(n)));
    await self.clients.claim();
    await broadcastToClients({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
    await trimRuntimeCache().catch(() => {});
    await flushQueue().catch(() => {});
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;

  if (request.method !== 'GET') {
    const isFirestore = BYPASS_PATTERNS.some(p => request.url.includes(p));
    if (isFirestore) {
      event.respondWith(
        fetch(request.clone()).catch(async () => {
          const uid = url.searchParams.get('uid')
            || [...url.pathname.matchAll(/\/users\/([^/]+)\//g)].pop()?.[1]
            || 'unknown';
          await enqueueRequest(uid, request);
          return new Response(
            JSON.stringify({ __queued: true, ts: Date.now() }),
            { status: 202, headers: { 'Content-Type': 'application/json', 'X-SW-Queued': '1' } }
          );
        })
      );
    }
    return;
  }

  if (BYPASS_PATTERNS.some(p => request.url.includes(p))) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.origin === self.location.origin && API_BYPASS.some(p => url.pathname.startsWith(p))) {
    event.respondWith(fetch(request));
    return;
  }

  const isShell =
    url.pathname === '/' ||
    url.pathname.endsWith('index.html') ||
    url.pathname.endsWith('app.html') ||
    url.pathname.endsWith('sign.html') ||
    url.pathname === self.location.pathname.replace('sw.js', '');

  if (isShell) { event.respondWith(swrShell(request)); return; }
  if (CDN_PATTERNS.some(p => request.url.includes(p))) { event.respondWith(cacheFirst(request, STATIC_CACHE)); return; }

  if (url.origin === self.location.origin) {
    const ext = url.pathname.split('.').pop().toLowerCase();
    if (['js','css','png','jpg','jpeg','svg','ico','webp','woff','woff2','ttf','json','webmanifest'].includes(ext)) {
      event.respondWith(cacheFirst(request, SHELL_CACHE));
      return;
    }
  }

  event.respondWith(networkFirst(request));
});

async function swrShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const ctrl  = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), 2500);
  let networkRes = null;
  try {
    // IMPORTANT: navigation requests arrive with redirect:'manual' (spec
    // default for FetchEvent navigations). new Request(request,{...}) with
    // only `signal` set inherits that mode silently. Cloudflare Pages
    // 308-redirects .html paths to their clean-URL form (e.g. /sign.html ->
    // /sign), so fetch() then returns an opaqueredirect response — which
    // Chrome refuses to let respondWith() use, producing ERR_FAILED /
    // "This site can't be reached" instead of the actual page. Forcing
    // redirect:'follow' here makes the SW follow it like a normal browser
    // request would.
    networkRes = await fetch(new Request(request, { signal: ctrl.signal, redirect: 'follow' }));
    clearTimeout(tid);
    if (networkRes.ok) {
      cache.put(request, networkRes.clone());
      // Only alias as index.html for the root/index requests
      const p = new URL(request.url).pathname;
      if (p === '/' || p.endsWith('index.html')) {
        cache.put('./index.html', networkRes.clone());
      }
      return networkRes;
    }
  } catch { clearTimeout(tid); }
  const cached = await cache.match(request) || await cache.match('./index.html') || await cache.match('./');
  if (cached) return cached;
  return new Response(
    '<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Fee Tracker</h2><p>You are offline and the app has not been cached yet. Connect to the internet and reload.</p></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    fetch(new Request(request, { redirect: 'follow' })).then(r => { if (r.ok) cache.put(request, r.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(new Request(request, { redirect: 'follow' }));
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(new Request(request, { redirect: 'follow' }));
    if (res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, res.clone());
      stampCacheEntry(request.url).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('sync', event => {
  if (event.tag === 'ft-offline-queue') event.waitUntil(flushQueue());
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'fee-reminder-check') event.waitUntil(handlePeriodicReminder());
});

async function handlePeriodicReminder() {
  const windows = await self.clients.matchAll({ type: 'window' });
  if (windows.length > 0) { broadcastToClients({ type: 'PERIODIC_REMINDER_CHECK' }); return; }
  const profile  = await idbGet('kv', '__sw_profile');
  if (!profile?.uid) return;
  const teachers = await idbGet('kv', `${profile.uid}__teachers`);
  if (!teachers || !Object.keys(teachers).length) return;
  const now  = new Date();
  const curM = now.getMonth() + 1;
  const curY = now.getFullYear();
  const due  = Object.values(teachers).filter(t => {
    if (!t.baselineMonth || !t.baselineYear) return false;
    return (curY - t.baselineYear) * 12 + (curM - t.baselineMonth) > 0;
  });
  if (!due.length) return;
  const total = due.reduce((sum, t) => {
    const mo = Math.max((curY - t.baselineYear) * 12 + (curM - t.baselineMonth), 0);
    return sum + (t.fee || 0) * mo;
  }, 0);
  await self.registration.showNotification('Fee Tracker — Dues Pending', {
    body:     `${due.length} teacher${due.length > 1 ? 's' : ''} overdue · ₹${total.toLocaleString('en-IN')} total`,
    icon:     './icons/icon-192.png',
    badge:    './icons/icon-192.png',
    tag:      'ft-reminder',
    renotify: false,
    data:     { url: './' },
    actions:  [{ action: 'open', title: 'Open App' }, { action: 'dismiss', title: 'Later' }],
  });
}

self.addEventListener('push', event => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); }
  catch { payload = { title: 'Fee Tracker', body: event.data.text() }; }
  const title   = payload.notification?.title || payload.title || 'Fee Tracker';
  const options = {
    body:     payload.notification?.body || payload.body || '',
    icon:     './icons/icon-192.png',
    badge:    './icons/icon-192.png',
    tag:      payload.tag || 'ft-push',
    renotify: !!payload.renotify,
    vibrate:  [150, 80, 150],
    data:     { url: payload.click_action || './', ...(payload.data || {}) },
    actions:  [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { action }     = event;
  const { url = './' } = event.notification.data || {};
  if (action === 'dismiss') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const match   = clients.find(c => c.url.includes(self.location.origin));
    if (match) { await match.focus(); match.postMessage({ type: 'NOTIFICATION_CLICK', url }); }
    else { const w = await self.clients.openWindow(url); w?.postMessage({ type: 'NOTIFICATION_CLICK', url }); }
  })());
});

self.addEventListener('message', event => {
  const { type } = event.data || {};
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'CLEAR_CACHE':
      event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
        await idbClear('sw_queue');
        await idbClear('sw_meta');
        _lastFlush = 0;
      })());
      break;
    case 'FLUSH_QUEUE':
      _lastFlush = 0;
      event.waitUntil(flushQueue());
      break;
    case 'CACHE_SNAPSHOT': {
      const { key, value } = event.data;
      if (key != null && value !== undefined) event.waitUntil(idbPut('kv', key, value));
      break;
    }
    case 'TRIM_CACHE':
      event.waitUntil(trimRuntimeCache());
      break;
    case 'QUEUE_STATUS': {
      const port = event.ports?.[0];
      if (!port) break;
      event.waitUntil(idbGetAll('sw_queue').then(items => port.postMessage({ queueLength: items.length, version: CACHE_VERSION })));
      break;
    }
    case 'RECACHE_SHELL':
      event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.allSettled(SHELL_ASSETS.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => r.ok ? cache.put(u, r) : null).catch(() => {})));
        broadcastToClients({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
      })());
      break;
    case 'PURGE_QUEUE': {
      const { uid } = event.data;
      if (!uid) break;
      event.waitUntil((async () => {
        const items = await idbGetAll('sw_queue');
        await Promise.all(items.filter(i => i.uid === uid).map(i => idbDelete('sw_queue', i.id)));
      })());
      break;
    }
  }
});
