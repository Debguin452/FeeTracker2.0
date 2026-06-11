import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { initializeFirestore, persistentLocalCache, collection, addDoc, getDocs, deleteDoc, doc, setDoc, getDoc, updateDoc,
         query, where }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, browserLocalPersistence, setPersistence }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getMessaging, getToken, onMessage }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";

let _cfg = null;
async function _getConfig() {
  if (_cfg) return _cfg;
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('Config fetch failed: ' + r.status);
  _cfg = await r.json();
  return _cfg;
}
const _cfgPromise = _getConfig();

(function applySWHydration() {
  try {
    const h = window.__SW_HYDRATE__;
    if (!h || typeof h !== 'object') return;
    
    const firstKey = Object.keys(h)[0] || '';
    const uid = firstKey.split('__')[0] || '';
    if (!uid) return;

    try { if (!localStorage.getItem('ft_uid')) localStorage.setItem('ft_uid', uid); } catch {}

    window.__SW_HYDRATE_UID__ = uid;
    window.__SW_HYDRATE_MAP__ = {};
    Object.entries(h).forEach(([k, entry]) => {
      const dataKey = k.replace(uid + '__', '');
      window.__SW_HYDRATE_MAP__[dataKey] = entry.value;
    });
  } catch (err) {

  }
})();

// ── Safety net ─────────────────────────────────────────────────────────────
// Registered SYNCHRONOUSLY before any await, so it fires even if the module
// crashes on config load. After 5 s it forces the login screen visible.
window.__ftReady = false;
const _safetyTid = setTimeout(() => {
  if (window.__ftReady) return;
  const _sp = document.getElementById('splashSkeleton');
  if (!_sp || _sp.classList.contains('fade-out')) return;
  _sp.classList.add('fade-out');
  setTimeout(() => {
    _sp.remove();
    const _ls  = document.getElementById('loginScreen');
    const _lsk = document.getElementById('loginSkeleton');
    const _lc  = document.getElementById('loginContent');
    if (_ls)  _ls.classList.remove('hidden');
    if (_lsk) {
      _lsk.classList.add('fade-out');
      setTimeout(() => { _lsk.classList.add('hidden'); if (_lc) { _lc.style.opacity='1'; _lc.style.pointerEvents='auto'; }}, 420);
    } else if (_lc) { _lc.style.opacity='1'; _lc.style.pointerEvents='auto'; }
    // If the module is dead, give the user a way out
    const _btn = document.getElementById('googleSignInBtn');
    if (_btn) { _btn.disabled = false; }
    const _note = document.querySelector('.login-note');
    if (_note && !window.__ftReady) _note.textContent = 'Having trouble? Reload the page to try again.';
  }, 420);
}, 5000);

const cfg = await _cfgPromise;
window.__ftReady = true;   // config loaded — cancel safety net
clearTimeout(_safetyTid);

const _app1 = initializeApp(cfg.firebase.primary, 'primary');

const _db1 = initializeFirestore(_app1, { localCache: persistentLocalCache() });

let db = _db1;

const auth = getAuth(_app1);
const provider = new GoogleAuthProvider();

let messaging = null;
try { messaging = getMessaging(_app1); } catch {}

const VAPID_KEY = cfg.vapidKey;
provider.setCustomParameters({ prompt:'select_account' });

let cu = null, teachers = {}, batches = {}, payments = [], searchQ = '', profile = {};
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _debounce(fn, wait) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

const _cooldowns = {};
function _cooldown(key, ms) {
  const now = Date.now();
  if (_cooldowns[key] && (now - _cooldowns[key]) < ms) return false;
  _cooldowns[key] = now;
  return true;
}

const _writeLocks = {};
async function _writeLock(key) {
  while (_writeLocks[key]) {
    await new Promise(r => setTimeout(r, 80));
  }
  _writeLocks[key] = true;
  return () => { delete _writeLocks[key]; };
}

const _CONNECT_NOTIF_TTL = 60 * 1000; 
let _connectNotifTs = 0;

const _currencyMap = {
  'en-IN':'INR','en-US':'USD','en-GB':'GBP','en-AU':'AUD','en-CA':'CAD',
  'en-NZ':'NZD','en-SG':'SGD','zh-CN':'CNY','zh-TW':'TWD','ja-JP':'JPY',
  'ko-KR':'KRW','th-TH':'THB','id-ID':'IDR','ms-MY':'MYR','vi-VN':'VND',
  'de-DE':'EUR','fr-FR':'EUR','it-IT':'EUR','es-ES':'EUR','pt-PT':'EUR',
  'nl-NL':'EUR','pl-PL':'PLN','ru-RU':'RUB','tr-TR':'TRY','ar-SA':'SAR',
  'ar-AE':'AED','he-IL':'ILS','hi-IN':'INR','bn-IN':'INR','ta-IN':'INR',
  'ur-PK':'PKR','pt-BR':'BRL','es-MX':'MXN','es-AR':'ARS','af-ZA':'ZAR',
  'sw-KE':'KES','am-ET':'ETB','zh-HK':'HKD',
};
function _detectCurrency(){
  const lang=navigator.language||'en-IN';
  if(_currencyMap[lang]) return _currencyMap[lang];
  const m=Object.keys(_currencyMap).find(k=>k.startsWith(lang.split('-')[0]+'-'));
  return m?_currencyMap[m]:'INR';
}
const USER_CURRENCY=_detectCurrency();
const USER_LOCALE=navigator.language||'en-IN';
function fmt(n){
  try{ return new Intl.NumberFormat(USER_LOCALE,{style:'currency',currency:USER_CURRENCY,maximumFractionDigits:0}).format(n); }
  catch(e){ return '₹'+n.toLocaleString(); }
}
function fmtCompact(n){
  try{ return new Intl.NumberFormat(USER_LOCALE,{style:'currency',currency:USER_CURRENCY,notation:'compact',maximumFractionDigits:1}).format(n); }
  catch(e){ return fmt(n); }
}
window._fmt=fmt;
function _applyCurSymbol(){
  try{
    const sym=(0).toLocaleString(USER_LOCALE,{style:'currency',currency:USER_CURRENCY,minimumFractionDigits:0}).replace(/[0-9,. ]/g,'').trim();
    document.querySelectorAll('.cur').forEach(el=>{ el.textContent=sym; });
  }catch(e){}
}
document.addEventListener('DOMContentLoaded',_applyCurSymbol);
window._applyCurSymbol=_applyCurSymbol;

const uid    = () => cu.uid;

function getCacheUid(){
  return (cu && cu.uid) || localStorage.getItem('ft_uid') || 'anon';
}
const tcCol  = () => collection(db,'users',uid(),'teachers');
const btCol  = () => collection(db,'users',uid(),'batches');
const pyCol  = () => collection(db,'users',uid(),'payments');
const tcDoc  = id => doc(db,'users',uid(),'teachers',id);
const btDoc  = id => doc(db,'users',uid(),'batches',id);
const pyDoc  = id => doc(db,'users',uid(),'payments',id);
const prRef  = () => doc(db,'users',uid(),'meta','profile');
const isT    = () => profile.role === 'teacher';

const IDB_NAME  = 'fee-tracker-cache';
const IDB_VER   = 5;   
const IDB_STORE = 'kv';

const idbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, IDB_VER);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    
    if (!db.objectStoreNames.contains(IDB_STORE)) {
      db.createObjectStore(IDB_STORE);
    }
    
    if (!db.objectStoreNames.contains('batches_detail')) {
      db.createObjectStore('batches_detail');
    }
  };
  req.onsuccess = e => resolve(e.target.result);
  req.onerror   = e => reject(e.target.error);
  // Another tab is holding the old DB version open — don't hang forever.
  // Reject after 3s so idbGet/idbSet fall back to LS gracefully.
  req.onblocked = () => setTimeout(() => reject(new Error('idb_blocked')), 3000);
});

function idbKey(k){ return `${getCacheUid()}__${k}`; }

async function idbGet(k, store=IDB_STORE){
  try {
    const db = await idbReady;
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const r  = tx.objectStore(store).get(idbKey(k));
      r.onsuccess = () => res(r.result ?? null);
      r.onerror   = () => rej(r.error);
    });
  } catch(e){ return null; }
}

async function idbSet(k, v, store=IDB_STORE){
  try {
    const db = await idbReady;
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const r  = tx.objectStore(store).put(v, idbKey(k));
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function idbDel(k, store=IDB_STORE){
  try {
    const db = await idbReady;
    return new Promise((res,rej)=>{
      const tx=db.transaction(store,'readwrite');
      const r=tx.objectStore(store).delete(idbKey(k));
      r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
    });
  } catch(e){}
}

function saveBatchDetailToCache(bid){
  if(!bid) return;
  idbSet(bid, { students: batchStudents, payments: batchPayments }, 'batches_detail');
  
  try { idbSet('_batchDetailTs_'+bid, Date.now()); } catch(e){}
}
async function loadBatchDetailFromCache(bid){
  const d = await idbGet(bid, 'batches_detail');
  return d || null; 
}

function _invalidateBatchCache(bid){
  try { idbSet('_batchDetailTs_'+bid, null); idbSet('_lastSyncTs', null); } catch(e){}
}

const LS = {
  get: (k) => { try { const v=localStorage.getItem(`ft__${getCacheUid()}__${k}`); return v?JSON.parse(v):null; } catch{ return null; } },
};

function loadFromCache(){
  
  const ct=LS.get('teachers'); if(ct) teachers=ct;
  const cp=LS.get('payments'); if(cp) payments=cp;
  const cb=LS.get('batches');  if(cb) batches=cb;
  const cpr=LS.get('profile'); if(cpr){ profile=cpr; }
}

async function loadFromCacheAsync(){
  
  const swm = window.__SW_HYDRATE_MAP__ || {};

  // Race IDB reads against a 2s timeout — if IDB is blocked (another tab
  // holding the old version), fall through immediately to LS/SW fallbacks.
  const _idbTimeout = new Promise(r => setTimeout(() => r([null,null,null,null,null]), 2000));
  const [ct,cp,cb,cpr,css] = await Promise.race([
    Promise.all([
      idbGet('teachers'), idbGet('payments'), idbGet('batches'),
      idbGet('profile'), idbGet('standalone_students')
    ]),
    _idbTimeout
  ]);

  if(ct)        teachers=ct;
  else if(swm.teachers) teachers=swm.teachers;
  else { const v=LS.get('teachers'); if(v) teachers=v; }

  if(cp)        payments=cp;
  else if(swm.payments) payments=swm.payments;
  else { const v=LS.get('payments'); if(v) payments=v; }

  if(cb)        batches=cb;
  else if(swm.batches) batches=swm.batches;
  else { const v=LS.get('batches'); if(v) batches=v; }

  if(cpr){ profile=cpr; updateRole(); }
  else if(swm.profile){ profile=swm.profile; updateRole(); }
  else { const v=LS.get('profile'); if(v){ profile=v; updateRole(); } }

  if(css)             _standaloneStudents=css;
  else if(swm.standalone_students) _standaloneStudents=swm.standalone_students;
}

function saveToCache(){
  
  idbSet('teachers', teachers);
  idbSet('payments', payments);
  idbSet('batches',  batches);
  if(_standaloneStudents && _standaloneStudents.length >= 0) {
    idbSet('standalone_students', _standaloneStudents);
  }
  
  try { localStorage.setItem(`ft__${getCacheUid()}__teachers`, JSON.stringify(teachers)); } catch(e){}
  try { localStorage.setItem(`ft__${getCacheUid()}__payments`, JSON.stringify(payments)); } catch(e){}
  try { localStorage.setItem(`ft__${getCacheUid()}__batches`,  JSON.stringify(batches));  } catch(e){}
  
  _swMirror();
  
  _updateWidget();
}

function _updateWidget(){
  try {
    const sw = navigator.serviceWorker?.controller;
    if(!sw) return;
    const n = new Date();
    const due = isT()
      ? null  
      : totalDue();
    const pending = isT()
      ? null
      : Object.keys(teachers).filter(id=>monthsDue(id)>0).length;
    const total = isT()
      ? Object.keys(batches).length
      : Object.keys(teachers).length;
    sw.postMessage({
      type: 'UPDATE_WIDGET',
      data: {
        due,
        pending,
        total,
        role: profile.role||'student',
        name: profile.displayName||'',
        updatedAt: n.toLocaleTimeString(USER_LOCALE,{hour:'2-digit',minute:'2-digit'}),
      }
    });
  } catch(e){}
}

function saveProfileToCache(p){
  idbSet('profile', p);
  try { localStorage.setItem(`ft__${getCacheUid()}__profile`, JSON.stringify(p)); } catch(e){}
  
  const uid = getCacheUid();
  if(uid && uid !== 'anon') {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'MIRROR_DATA', uid, key: 'profile', value: p
    });
  }
}

function _swMirror(){
  try {
    const uid = getCacheUid();
    if(!uid || uid === 'anon') return;
    const sw = navigator.serviceWorker?.controller;
    if(!sw) return;
    const bundle = { teachers, payments, batches };
    if(_standaloneStudents && _standaloneStudents.length >= 0)
      bundle.standalone_students = _standaloneStudents;
    sw.postMessage({ type: 'MIRROR_BUNDLE', uid, bundle });
  } catch(e){}
}

function showOfflineBanner(show){
  
  if(show && navigator.onLine) return;
  let b=document.getElementById('offlineBanner');
  if(!b){ b=document.createElement('div'); b.id='offlineBanner';
    b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(255,154,60,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#1a1009;text-align:center;font-size:11px;font-weight:700;padding:8px 16px;letter-spacing:.2px;display:flex;align-items:center;justify-content:center;gap:4px;transition:transform .3s cubic-bezier(.34,1.2,.64,1);transform:translateY(-100%);box-shadow:0 2px 12px rgba(0,0,0,.2);';
    b.innerHTML='<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:middle;margin-right:5px;flex-shrink:0"><path d="M1 1l14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10.6 7.4A6 6 0 0 1 13 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/><path d="M3.2 9A6 6 0 0 1 5.7 7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/><path d="M6 11a3 3 0 0 1 4 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="14" r="1.2" fill="currentColor"/></svg> Offline — cached data'; b.style.cursor='default'; document.body.appendChild(b); }
  b.style.transform=show?'translateY(0)':'translateY(-100%)';
}

window.addEventListener('online', async () => {
  _onlineSince=Date.now();
  showOfflineBanner(false);
  const _cb=document.getElementById('menuConnectBtn'); if(_cb) _cb.style.display='';
  navigator.serviceWorker?.controller?.postMessage({ type: 'ONLINE' });

  if (loaded && profile.role) {
    
    const hadLocalPays = (payments||[]).some(p => p.id?.startsWith('local_'));
    toast(hadLocalPays ? 'Back online — uploading payments…' : 'Back online — syncing…', 'success');
    await loadAll(true);

  } else if (_offlineBooted) {
    toast('Back online — syncing…', 'success');
    _reconnecting  = true;
    loaded         = false;
    _offlineBooted = false;
    setTimeout(() => {
      _reconnecting = false;
      if (!loaded) window.location.reload();
    }, 5000);
  }
});
window.addEventListener('offline', ()=>{
  showOfflineBanner(true);
});

if(!navigator.onLine){ const _cbi=document.getElementById('menuConnectBtn'); if(_cbi) _cbi.style.display='none'; showOfflineBanner(true); }

function mBetween(a,b){ return (b.year-a.year)*12+(b.month-a.month); }
function addM(b,n){ let m=b.month+n,y=b.year; while(m>12){m-=12;y++;} return {month:m,year:y}; }

let _toastTimer=null;
function toast(msg,type=''){
  const t=document.getElementById('toast');
  if(_toastTimer){ clearTimeout(_toastTimer); t.classList.remove('show'); void t.offsetWidth; }
  t.textContent=msg; t.className='toast '+(type||'');
  void t.offsetWidth; t.classList.add('show');
  _toastTimer=setTimeout(()=>{ t.classList.remove('show'); _toastTimer=null; },2800);
}

let _confirmResolve = null;
function _confirmDone(v){
  document.getElementById('confirmOverlay').classList.add('hidden');
  if(_confirmResolve){ _confirmResolve(v); _confirmResolve=null; }
}
document.getElementById('confirmOkBtn').addEventListener('click', ()=>_confirmDone(true));
document.getElementById('confirmCancelBtn').addEventListener('click', ()=>_confirmDone(false));
document.getElementById('confirmOverlay').addEventListener('click', e=>{
  if(e.target===document.getElementById('confirmOverlay')) _confirmDone(false);
});

const _CI = {
  warn : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(255,154,60,.12)" stroke="rgba(255,154,60,.35)" stroke-width="1.5"/><path d="M18 10L8 27h20L18 10z" fill="rgba(255,154,60,.15)" stroke="#ff9a3c" stroke-width="1.8" stroke-linejoin="round"/><line x1="18" y1="17" x2="18" y2="22" stroke="#ff9a3c" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="25" r="1.2" fill="#ff9a3c"/></svg>`,
  del  : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(255,77,109,.12)" stroke="rgba(255,77,109,.35)" stroke-width="1.5"/><path d="M11 13h14M15 13v-2h6v2M14 13l1 12h6l1-12" stroke="#ff4d6d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rem  : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(255,77,109,.1)" stroke="rgba(255,77,109,.3)" stroke-width="1.5"/><circle cx="18" cy="14" r="3.5" stroke="#ff4d6d" stroke-width="1.6"/><path d="M10 27c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke="#ff4d6d" stroke-width="1.6" stroke-linecap="round"/><path d="M22 11l3 3M25 11l-3 3" stroke="#ff4d6d" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  pay  : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(0,212,170,.1)" stroke="rgba(0,212,170,.3)" stroke-width="1.5"/><rect x="9" y="13" width="18" height="12" rx="2.5" fill="rgba(0,212,170,.12)" stroke="#00d4aa" stroke-width="1.6"/><line x1="9" y1="18" x2="27" y2="18" stroke="#00d4aa" stroke-width="1.6"/><rect x="11" y="21" width="6" height="2" rx="1" fill="#00d4aa" opacity=".7"/></svg>`,
  part : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(255,154,60,.1)" stroke="rgba(255,154,60,.3)" stroke-width="1.5"/><rect x="9" y="13" width="18" height="12" rx="2.5" fill="rgba(255,154,60,.1)" stroke="#ff9a3c" stroke-width="1.6"/><line x1="9" y1="18" x2="27" y2="18" stroke="#ff9a3c" stroke-width="1.6"/><path d="M14 21.5h5" stroke="#ff9a3c" stroke-width="2" stroke-linecap="round"/></svg>`,
  adv  : `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="17" fill="rgba(124,107,255,.1)" stroke="rgba(124,107,255,.3)" stroke-width="1.5"/><path d="M11 23l7-10 7 10" stroke="#7c6bff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 20h6" stroke="#7c6bff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

    function confirm2(title,msg,ok='Confirm',icon=_CI.warn){
  return new Promise(res=>{
    if(_confirmResolve) _confirmResolve(false); 
    _confirmResolve=res;
    document.getElementById('confirmIcon').innerHTML=icon;
    document.getElementById('confirmTitle').textContent=title;
    document.getElementById('confirmMsg').innerHTML=msg;
    document.getElementById('confirmOkBtn').textContent=ok;
    document.getElementById('confirmOverlay').classList.remove('hidden');
  });
}

function lastPaid(id){
  const t=teachers[id];
  const _now=new Date(),_prev=new Date(_now.getFullYear(),_now.getMonth()-1,1);
  let seedDay=1;
  if(t.lastPaidDate){ const pp=t.lastPaidDate.split('-'); if(pp[2]) seedDay=parseInt(pp[2])||1; }
  let lp={month:t.baselineMonth||(_prev.getMonth()+1),year:t.baselineYear||_prev.getFullYear(),day:seedDay};
  let rp=0;
  payments.filter(p=>p.teacherId===id).sort((a,b)=>a.timestamp-b.timestamp).forEach(p=>{
    if(p.type==='partial'){ rp+=p.amount; const c=Math.floor(rp/t.fee); if(c>0){lp=addM(lp,c); lp.day=p.paidOn?.day||lp.day; rp%=t.fee;} }
    else if(p.monthsPaid){ lp=addM(lp,p.monthsPaid); lp.day=p.paidOn?.day||1; rp=0; }
  });
  return lp;
}
function partialBal(id){
  const t=teachers[id]; let c=0;
  payments.filter(p=>p.teacherId===id).sort((a,b)=>a.timestamp-b.timestamp).forEach(p=>{
    if(p.type==='partial'){c+=p.amount;c%=t.fee;} else if(p.monthsPaid) c=0;
  });
  return c;
}
function monthsDue(id){
  const n=new Date(), lp=lastPaid(id);
  let m=mBetween(lp,{month:n.getMonth()+1,year:n.getFullYear()});
  
  if(m>0 && n.getDate()<(lp.day||1)) m--;
  return Math.max(m,0);
}
function calcDue(id){
  const t=teachers[id],mo=monthsDue(id); if(!mo) return 0;
  let d=mo*t.fee;
  if(t.lateAfter){ const td=new Date().getDate(); if(td>t.lateAfter) d+=(td-t.lateAfter)*(t.latePerDay||0); }
  return Math.max(d-partialBal(id),0);
}
function totalDue(){ return Object.keys(teachers).reduce((s,id)=>s+calcDue(id),0); }
function lastPaidStr(id){
  const tp=payments.filter(p=>p.teacherId===id).sort((a,b)=>b.timestamp-a.timestamp);
  if(!tp.length) return null;
  const p=tp[0]; return p.paidOn?`${p.paidOn.day} ${MONTHS[p.paidOn.month-1]} ${p.paidOn.year}`:null;
}

function getDeviceId() {
  let id = localStorage.getItem('ft_device_id');
  if (!id) {
    
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
           .map(b => b.toString(16).padStart(2,'0')).join('');
    localStorage.setItem('ft_device_id', id);
  }
  return id;
}

async function saveFCMToken(token) {
  if (!uid() || !token) return;
  const deviceId = getDeviceId();
  try {
    
    const existing = await getDoc(doc(db, 'users', uid(), 'fcmTokens', deviceId));
    if (existing.exists()) {

      return;
    }
    await setDoc(doc(db, 'users', uid(), 'fcmTokens', deviceId), {
      token,
      deviceId,
      deviceHint: (() => {
        const ua = navigator.userAgent;
        const androidModel = ua.match(/;\s*([^;)]+?)\s+Build\//);
        if (androidModel) {
          const raw = androidModel[1].trim();
          const samsungMap = {
            'SM-S918': 'Samsung Galaxy S23 Ultra', 'SM-S916': 'Samsung Galaxy S23+',
            'SM-S911': 'Samsung Galaxy S23',       'SM-S928': 'Samsung Galaxy S24 Ultra',
            'SM-S926': 'Samsung Galaxy S24+',      'SM-S921': 'Samsung Galaxy S24',
            'SM-S938': 'Samsung Galaxy S25 Ultra', 'SM-S936': 'Samsung Galaxy S25+',
            'SM-S931': 'Samsung Galaxy S25',       'SM-G991': 'Samsung Galaxy S21',
            'SM-G996': 'Samsung Galaxy S21+',      'SM-G998': 'Samsung Galaxy S21 Ultra',
            'SM-S901': 'Samsung Galaxy S22',       'SM-S906': 'Samsung Galaxy S22+',
            'SM-S908': 'Samsung Galaxy S22 Ultra', 'SM-A546': 'Samsung Galaxy A54',
            'SM-A536': 'Samsung Galaxy A53',       'SM-A336': 'Samsung Galaxy A33',
            'SM-A146': 'Samsung Galaxy A14',       'SM-A226': 'Samsung Galaxy A22',
            'SM-F946': 'Samsung Galaxy Z Fold5',   'SM-F731': 'Samsung Galaxy Z Flip5',
            'SM-N986': 'Samsung Galaxy Note 20 Ultra', 'SM-N981': 'Samsung Galaxy Note 20',
          };
          for (const [code, name] of Object.entries(samsungMap)) {
            if (raw.toUpperCase().startsWith(code)) return name;
          }
          if (/Pixel 9 Pro XL/i.test(raw)) return 'Google Pixel 9 Pro XL';
          if (/Pixel 9/i.test(raw)) return 'Google Pixel 9';
          if (/Pixel 8 Pro/i.test(raw)) return 'Google Pixel 8 Pro';
          if (/Pixel 8/i.test(raw)) return 'Google Pixel 8';
          if (/Pixel 7/i.test(raw)) return 'Google Pixel 7';
          return raw.length > 30 ? raw.slice(0,30) : raw;
        }
        if (/iPhone/.test(ua)) {
          const p = Math.max(screen.width, screen.height);
          if (p >= 932) return 'iPhone 15/16 Pro Max';
          if (p >= 852) return 'iPhone 15/16 Pro';
          if (p >= 844) return 'iPhone 14/15';
          return 'iPhone';
        }
        if (/iPad/.test(ua)) return 'iPad';
        if (/Windows/.test(ua)) return 'Windows PC';
        if (/Macintosh/.test(ua)) return 'Mac';
        return 'Unknown device';
      })(),
      createdAt: Date.now(),
    });

  } catch {}
}

async function refreshFCMTokenIfNeeded() {
  if (!messaging || !uid()) return;
  
  if (Notification.permission !== 'granted') return;
  try {
    const deviceId = getDeviceId();
    
    const existing = await getDoc(doc(db, 'users', uid(), 'fcmTokens', deviceId));
    if (existing.exists()) {
      if (!localStorage.getItem('ft_fcm_token')) {
        localStorage.setItem('ft_fcm_token', existing.data().token);
      }
      return; 
    }
    
    const sw    = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: sw });
    if (!token) { return; }
    localStorage.setItem('ft_fcm_token', token);
    await saveFCMToken(token);

  } catch {}
}

async function removeFCMToken() {
  if (!uid()) return;
  const deviceId = getDeviceId();
  try { await deleteDoc(doc(db, 'users', uid(), 'fcmTokens', deviceId)); } catch(e) {}
}

function buildReminderBody(dueTeachers) {
  const count = dueTeachers.length;
  const total = dueTeachers.reduce((s, id) => s + calcDue(id), 0);
  const _fmt2 = window._fmt || (n => n.toLocaleString());

  if (count === 0) return null;

  if (count === 1) {
    
    const t  = teachers[dueTeachers[0]];
    const mo = monthsDue(dueTeachers[0]);
    return `${t.name} — ${mo} month${mo>1?'s':''} due (${_fmt2(calcDue(dueTeachers[0]))})`;
  }

  if (count === 2) {
    
    const n1 = teachers[dueTeachers[0]].name.split(' ')[0];
    const n2 = teachers[dueTeachers[1]].name.split(' ')[0];
    return `${n1} & ${n2} — ${_fmt2(total)} total due`;
  }

  return `${count} teachers — ${_fmt2(total)} total outstanding`;
}

async function initNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { updateNotifMenuLabel(); return; }

    await refreshFCMTokenIfNeeded();

    updateNotifMenuLabel();
    window._checkDueReminder();
  } catch {}
}

async function checkDueReminder(force = false) {
  if (Notification.permission !== 'granted') return;

  const today = new Date();
  const lastShown = parseInt(localStorage.getItem('ft_last_reminder') || '0');
  const daysSince = (Date.now() - lastShown) / 86400000;

  if (!force) {
    if (daysSince < 25) return;
    
    if (today.getDate() > 5) return;
  }

  const _fmt2 = window._fmt || (n => n.toLocaleString());
  let body = null;

  if (!isT()) {
    
    const dueTeachers = Object.keys(teachers).filter(id => monthsDue(id) > 0);
    body = buildReminderBody(dueTeachers);
  } else {
    
    const curM = today.getMonth()+1, curY = today.getFullYear();
    let dueCount = 0, dueNames = [];
    for (const bid of Object.keys(batches)) {
      try {
        const cached = await loadBatchDetailFromCache(bid);
        if (!cached) continue;
        const fee = batches[bid]?.fee || 0;
        if (!fee) continue;
        Object.keys(cached.students||{}).forEach(sid => {
          const st = cached.students[sid];
          const _np = new Date(today.getFullYear(), today.getMonth()-1, 1);
          let lp = {month: st.baselineMonth||(_np.getMonth()+1), year: st.baselineYear||(_np.getFullYear()), day: 1};
          let rp = 0;
          (cached.payments||[]).filter(p=>p.studentId===sid).sort((a,b)=>a.timestamp-b.timestamp).forEach(p=>{
            if(p.type==='partial'){rp+=p.amount;const c=Math.floor(rp/fee);if(c>0){lp=addM(lp,c);lp.day=p.paidOn?.day||lp.day;rp%=fee;}}
            else if(p.monthsPaid){lp=addM(lp,p.monthsPaid);lp.day=p.paidOn?.day||1;rp=0;}
          });
          const mo = Math.max(mBetween(lp,{month:curM,year:curY}),0);
          const dayAdj = (mo>0 && today.getDate()<(lp.day||1)) ? 1 : 0;
          if (Math.max(mo-dayAdj,0) > 0) { dueCount++; if(dueNames.length < 2) dueNames.push(st.name); }
        });
      } catch(e){}
    }
    
    (_standaloneStudents||[]).forEach(s => {
      const fee = s.fee||0; if(!fee) return;
      const _np2 = new Date(today.getFullYear(), today.getMonth()-1, 1);
      const lp = {month: s.baselineMonth||(_np2.getMonth()+1), year: s.baselineYear||_np2.getFullYear()};
      const mo = Math.max(mBetween(lp,{month:today.getMonth()+1,year:today.getFullYear()}),0);
      if (mo > 0) { dueCount++; if(dueNames.length < 2) dueNames.push(s.name); }
    });
    if (dueCount === 0) return;
    if (dueCount === 1) body = `${dueNames[0]} has fees due this month`;
    else if (dueCount === 2) body = `${dueNames[0]} & ${dueNames[1]} have fees due`;
    else body = `${dueCount} students have fees due this month`;
  }

  if (!body) return;

  new Notification('Fee Reminder 💰', {
    body,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    tag:      'due-reminder',
    renotify: true,
  });
  localStorage.setItem('ft_last_reminder', String(Date.now()));
}

function showNotifPrompt() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('ft_notif_dismissed')) return;
  const banner = document.getElementById('notifBanner');
  if (banner) setTimeout(() => banner.classList.add('show'), 2000);
}

async function loadProfile(){
  
  if(!profile.role){
    const cached = await idbGet('profile') || LS.get('profile');
    if(cached){ profile=cached; updateRole(); }
  }
  
  try {
    const profileTs = await idbGet('_profileSyncTs');
    if (profile.role && profileTs && (Date.now() - profileTs) < 10 * 60 * 1000) {
      updateRole();
      return; 
    }
  } catch(e) {  }
  try{
    const _timeout = new Promise((_,rej) => setTimeout(() => rej(new Error('profile_timeout')), 5000));
    const s=await Promise.race([getDoc(prRef()), _timeout]);
    if(s.exists()){
      profile=s.data(); saveProfileToCache(profile);
      try { await idbSet('_profileSyncTs', Date.now()); } catch(e){}
    }
  } catch {}
  updateRole();
}
function updateRole(){
  const r=profile.role||'student';
  const n=profile.displayName||cu?.displayName||'';
  const sub=r==='teacher'
    ? (profile.classes&&profile.classes.length ? profile.classes.join(', ') : 'Teacher Mode')
    : (profile.className || 'Personal Tracker');
  document.getElementById('topbarLabel').textContent = sub;
  const pill=document.getElementById('menuRolePill');
  pill.innerHTML=r==='teacher'?`<span style='display:inline-flex;align-items:center;gap:4px;'><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><circle cx="7" cy="5.5" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M1 15c0-3.3 2.7-5 6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 10v6M10 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> Teacher</span>`:`<span style='display:inline-flex;align-items:center;gap:4px;'><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0" ><path d="M2 8l6-4 6 4M4 9.5V13h8V9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="14" y1="8" x2="14" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Student</span>`;
  pill.className='menu-role-pill '+(r==='teacher'?'teacher':'student');
}

let pSubjects=[], pClasses=[];
function renderSubjTags(){
  document.getElementById('subjectTagsDisplay').innerHTML=
    pSubjects.map((s,i)=>`<div class="subject-tag">${s}<button class="subj-rm" onclick="rmSubj(${i})"><svg width="12" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`).join('');
}
function renderClassTags(){
  document.getElementById('classTagsDisplay').innerHTML=
    pClasses.map((c,i)=>`<div class="subject-tag" style="background:rgba(0,212,170,.12);border-color:rgba(0,212,170,.25);color:var(--accent3);">${c}<button class="subj-rm" onclick="rmClass(${i})"><svg width="12" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`).join('');
  
  document.querySelectorAll('#teacherFields .chip[data-val]').forEach(ch=>{
    ch.classList.toggle('selected', pClasses.includes(ch.dataset.val));
  });
}
window.addSubjectTag=function(){
  const inp=document.getElementById('subjectTagInput'), v=inp.value.trim();
  if(!v) return; if(!pSubjects.includes(v)) pSubjects.push(v); inp.value=''; renderSubjTags();
};
window.rmSubj=function(i){ pSubjects.splice(i,1); renderSubjTags(); };
window.addClassTag=function(){
  const inp=document.getElementById('classTagInput'), v=inp.value.trim();
  if(!v) return; if(!pClasses.includes(v)) pClasses.push(v); inp.value=''; renderClassTags();
};
window.rmClass=function(i){ pClasses.splice(i,1); renderClassTags(); };
window.toggleClassChip=function(el){
  const v=el.dataset.val;
  if(pClasses.includes(v)) pClasses=pClasses.filter(c=>c!==v);
  else pClasses.push(v);
  renderClassTags();
};
window.selectRole=function(r){
  document.getElementById('roleStudent').className='role-opt'+(r==='student'?' sel-student':'');
  document.getElementById('roleTeacher').className='role-opt'+(r==='teacher'?' sel-teacher':'');
  document.getElementById('studentFields').classList.toggle('hidden',r!=='student');
  document.getElementById('teacherFields').classList.toggle('hidden',r!=='teacher');
  const note=document.getElementById('roleSwitchNote');
  if(note) note.classList.toggle('hidden',!profile.role||r===profile.role);
};
window.selectChip=function(el){
  document.querySelectorAll('#profileModal .chip').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('profileClass').value=el.dataset.val;
};

function openProfileModal(){
  closeMenu();
  const r=profile.role||'student';
  selectRole(r);
  const _t=document.getElementById('profileModalTitle');
  if(_t) _t.textContent = profile.displayName ? 'Edit Profile' : 'Set Up Profile';
  const _n=document.getElementById('roleSwitchNote');
  if(_n) _n.classList.add('hidden');
  document.getElementById('profileName').value=profile.displayName||cu?.displayName||'';
  if(r==='student'){
    const cls=profile.className||'';
    document.getElementById('profileClass').value=cls;
    document.querySelectorAll('#profileModal .chip').forEach(c=>c.classList.toggle('selected',c.dataset.val===cls));
  } else {
    pSubjects=[...(profile.subjects||[])]; renderSubjTags();
    pClasses=[...(profile.classes||[])]; renderClassTags();
    document.getElementById('profileSession').value=profile.session||'';
  }
  const av=document.getElementById('profileAvatar');
  if(cu?.photoURL) av.innerHTML=`<img src="${cu.photoURL}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  else av.textContent=(profile.displayName||cu?.displayName||'U')[0].toUpperCase();
  document.getElementById('profileModal').classList.remove('hidden');
  
  if (typeof window._refreshThemeUI === 'function') window._refreshThemeUI();
}
function closeProfileModal(){ closeModal('profileModal'); }

async function saveProfile(){
  const btn=document.getElementById('saveProfileBtn'); btn.textContent='Saving…'; btn.disabled=true;
  const r=document.getElementById('roleTeacher').classList.contains('sel-teacher')?'teacher':'student';
  const d={role:r, displayName:document.getElementById('profileName').value.trim(), updatedAt:Date.now()};
  if(r==='student') d.className=document.getElementById('profileClass').value.trim();
  else { d.subjects=pSubjects; d.classes=pClasses; d.session=document.getElementById('profileSession').value.trim(); }
  try{
    const roleChanged = profile.role !== d.role;
    await setDoc(prRef(),d); profile=d; saveProfileToCache(d);
    
    try { await idbSet('_profileSyncTs', null); await idbSet('_lastSyncTs', null); } catch(e){}
    updateRole();
    closeProfileModal(); toast('Profile saved','success');
    if(roleChanged){ teachers={}; batches={}; payments=[]; appRendered=false; }
    await loadAll();
  } catch(e){ toast('Failed: '+e.message,'error'); }
  btn.textContent='Save Profile'; btn.disabled=false;
}

function showAppSkeleton(){
  if(appRendered) return;
  const root=document.getElementById('appInner');
  
  const studentCards=`
    <div class="sk-tc">
      <div class="sk-tc-body">
        <div style="flex:1;min-width:0;padding-right:12px;">
          <div class="sk" style="width:130px;height:15px;border-radius:6px;margin-bottom:7px;"></div>
          <div class="sk" style="width:90px;height:10px;border-radius:5px;margin-bottom:6px;opacity:.6;"></div>
          <div class="sk" style="width:70px;height:9px;border-radius:4px;opacity:.35;"></div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="sk" style="width:68px;height:22px;border-radius:7px;margin-bottom:6px;"></div>
          <div class="sk" style="width:44px;height:9px;border-radius:4px;opacity:.4;"></div>
        </div>
      </div>
      <div class="sk-tc-tabs">
        <div class="sk" style="height:40px;border-radius:10px;"></div>
        <div class="sk" style="height:40px;border-radius:10px;opacity:.55;"></div>
        <div class="sk" style="height:40px;border-radius:10px;opacity:.3;"></div>
      </div>
      <div class="sk-tc-pay">
        <div class="sk" style="flex:1;height:48px;border-radius:13px;"></div>
        <div class="sk" style="width:80px;height:48px;border-radius:13px;opacity:.7;"></div>
      </div>
      <div class="sk-tc-bar">
        <div class="sk" style="width:90px;height:9px;border-radius:5px;opacity:.35;"></div>
        <div class="sk" style="width:20px;height:20px;border-radius:6px;opacity:.25;"></div>
      </div>
    </div>
    <div class="sk-tc" style="opacity:.5;">
      <div class="sk-tc-body">
        <div style="flex:1;min-width:0;padding-right:12px;">
          <div class="sk" style="width:110px;height:15px;border-radius:6px;margin-bottom:7px;"></div>
          <div class="sk" style="width:76px;height:10px;border-radius:5px;opacity:.6;"></div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="sk" style="width:58px;height:22px;border-radius:7px;margin-bottom:6px;"></div>
          <div class="sk" style="width:38px;height:9px;border-radius:4px;opacity:.4;"></div>
        </div>
      </div>
      <div class="sk-tc-tabs">
        <div class="sk" style="height:40px;border-radius:10px;"></div>
        <div class="sk" style="height:40px;border-radius:10px;opacity:.55;"></div>
        <div class="sk" style="height:40px;border-radius:10px;opacity:.3;"></div>
      </div>
    </div>
    <div class="sk-tc" style="opacity:.22;">
      <div class="sk-tc-body">
        <div style="flex:1;min-width:0;padding-right:12px;">
          <div class="sk" style="width:95px;height:15px;border-radius:6px;margin-bottom:7px;"></div>
          <div class="sk" style="width:64px;height:10px;border-radius:5px;opacity:.6;"></div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="sk" style="width:52px;height:22px;border-radius:7px;"></div>
        </div>
      </div>
    </div>`;
  
  const batchCards=`
    <div class="sk-tc" style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
        <div style="flex:1;"><div class="sk" style="width:50%;height:14px;border-radius:6px;margin-bottom:7px;"></div><div class="sk" style="width:70%;height:11px;border-radius:5px;opacity:.6;"></div></div>
        <div class="sk sk-pill" style="width:58px;height:22px;"></div>
      </div>
      <div style="display:flex;gap:6px;"><div class="sk sk-pill" style="width:52px;height:22px;opacity:.5;"></div><div class="sk sk-pill" style="width:52px;height:22px;opacity:.35;"></div><div class="sk sk-pill" style="width:52px;height:22px;opacity:.2;"></div></div>
    </div>
    <div class="sk-tc" style="padding:16px;opacity:.55;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
        <div style="flex:1;"><div class="sk" style="width:45%;height:14px;border-radius:6px;margin-bottom:7px;"></div><div class="sk" style="width:65%;height:11px;border-radius:5px;opacity:.6;"></div></div>
        <div class="sk sk-pill" style="width:50px;height:22px;"></div>
      </div>
    </div>
    <div class="sk-tc" style="padding:16px;opacity:.25;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;"><div class="sk" style="width:40%;height:14px;border-radius:6px;"></div></div>
      </div>
    </div>`;
  root.innerHTML=`
    <div class="sk-hero"></div>
    <div class="sk" style="width:100%;height:42px;border-radius:14px;margin-bottom:18px;opacity:.8;"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div class="sk" style="width:68px;height:8px;border-radius:5px;opacity:.4;"></div>
      <div class="sk sk-pill" style="width:24px;height:15px;opacity:.3;"></div>
    </div>
    ${isT()?batchCards:studentCards}`;
}

let appRendered = false;

const _SYNC_TTL = 5 * 60 * 1000; 

async function loadAll(silent=false, force=false){
  
  if (!appRendered) {
    render(); 
  }

  if (!force) {
    try {
      const lastSync = await idbGet('_lastSyncTs');
      if (lastSync && (Date.now() - lastSync) < _SYNC_TTL) {

        if (!appRendered) render();
        appRendered = true;
        return;
      }
    } catch(e) {  }
  }

  const _prevTeachers = JSON.stringify(teachers);
  const _prevBatches  = JSON.stringify(batches);
  const _prevPayments = JSON.stringify(payments);
  
  const _prevBatchMeta = JSON.parse(_prevBatches || '{}');

  let fetchOk = false;
  try {
    if(isT()){
      const bs=await getDocs(btCol()); batches={};
      bs.forEach(d=>{ batches[d.id]=d.data(); });
    } else {
      const [ts,ps]=await Promise.all([getDocs(tcCol()),getDocs(pyCol())]);
      teachers={}; ts.forEach(d=>{ teachers[d.id]=d.data(); });
      payments=ps.docs.map(d=>({id:d.id,...d.data()}));
    }
    saveToCache();
    
    try { await idbSet('_lastSyncTs', Date.now()); } catch(e){}
    showOfflineBanner(false); fetchOk=true;
  } catch(e){ if(!navigator.onLine) showOfflineBanner(true); }

  if(isT() && fetchOk && Object.keys(batches).length > 0){
    Promise.all(Object.keys(batches).map(async bid => {
      try{
        const batchUnchanged = JSON.stringify(batches[bid]) === JSON.stringify(_prevBatchMeta[bid]);
        const cachedDetail   = await idbGet(bid, 'batches_detail').catch(()=>null);
        if (batchUnchanged && cachedDetail) {
          return; 
        }
        const [sSnap,pSnap] = await Promise.all([getDocs(stuCol(bid)),getDocs(bpyCol(bid))]);
        const studs={}, pays=[];
        sSnap.forEach(d=>{ studs[d.id]=d.data(); });
        pSnap.docs.forEach(d=>{ pays.push({id:d.id,...d.data()}); });
        await idbSet(bid, {students:studs,payments:pays}, 'batches_detail');
      }catch(e){}
    })).then(() => {});
  }

  if(isT()) { try { await loadStandaloneStudents(); } catch(e){} }

  const dataChanged = fetchOk && (
    JSON.stringify(teachers) !== _prevTeachers ||
    JSON.stringify(batches)  !== _prevBatches  ||
    JSON.stringify(payments) !== _prevPayments
  );
  if(dataChanged || !appRendered){
    render();
    setTimeout(()=>window._searchPHStart?.(), 400);
    setTimeout(()=>_updateWidget(), 200);
  }
}

window.switchPayTab=function(id,type){
  const tb=document.getElementById(`ptab-${type}-${id}`); if(tb?.disabled) return;
  ['full','partial','advance'].forEach(t=>{
    document.getElementById(`prow-${t}-${id}`)?.classList.toggle('hidden',t!==type);
    const el=document.getElementById(`ptab-${t}-${id}`);
    if(el){ el.classList.remove('active','active-partial','active-advance'); if(t===type) el.classList.add(t==='partial'?'active-partial':t==='advance'?'active-advance':'active'); }
  });
};

window.payMonths=async function(id,type='full'){
  const release = await _writeLock('pay_'+id);
  try {
  const t=teachers[id], n=new Date(), po={day:n.getDate(),month:n.getMonth()+1,year:n.getFullYear()};
  if(type==='full'){
    const max=monthsDue(id); if(!max) return toast('All clear','success');
    const v=parseInt(document.getElementById('pay-'+id).value);
    if(!v||v<1||v>max) return toast(`Enter 1\u2013${max}`,'error');
    const amt=v*t.fee;
    if(!await confirm2('Confirm Payment',`Mark <strong style="color:#f0f0f8">${fmt(amt)}</strong> for <strong style="color:#f0f0f8">${v} month${v>1?'s':''}</strong> to ${t.name}?`,'Mark',_CI.pay)) return;
    const newPay={teacherId:id,teacherName:t.name,subject:t.subject,monthsPaid:v,amount:amt,type:'full',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){
      newPay.id='local_'+Date.now(); payments.push(newPay); saveToCache();
      toast(`Paid ${fmt(amt)} ✓ (queued — will sync online)`,'success');
      
      addDoc(pyCol(),newPay).catch(()=>{});
    } else {
      const fref=await addDoc(pyCol(),newPay); newPay.id=fref.id; payments.push(newPay); saveToCache();
      try { idbSet('_lastSyncTs', null); } catch(e){}
      toast(`Paid ${fmt(amt)} ✓`,'success');
    }
    setTimeout(updateTotalCard, 100);
  } else if(type==='partial'){
    const amt=parseInt(document.getElementById('pay-partial-'+id).value);
    if(!amt||amt<1) return toast('Enter an amount','error');
    if(amt>=t.fee) return toast(`Use Full tab for ${fmt(t.fee)}+`,'error');
    const ex=partialBal(id), tot=ex+amt;
    if(tot>=t.fee) return toast(`Total ${fmt(tot)} covers full month — use Full tab`,'error');
    const rem=t.fee-tot;
    if(!await confirm2('Partial Payment',`Record <strong style="color:#f0f0f8">${fmt(amt)}</strong> partial to ${t.name}?<br><small style="color:var(--muted)">Still owed: ${fmt(rem)}</small>`,'Record',_CI.part)) return;
    const newPay2={teacherId:id,teacherName:t.name,subject:t.subject,amount:amt,type:'partial',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){
      newPay2.id='local_'+Date.now(); payments.push(newPay2); saveToCache();
      toast(`Partial ${fmt(amt)} queued — syncs online`,'success');
      addDoc(pyCol(),newPay2).catch(()=>{});
    } else {
      const fref2=await addDoc(pyCol(),newPay2); newPay2.id=fref2.id; payments.push(newPay2); saveToCache();
      try { idbSet('_lastSyncTs', null); } catch(e){}
      toast(`Partial ${fmt(amt)} recorded`,'success');
    }
    setTimeout(updateTotalCard, 100);
  } else if(type==='advance'){
    if(monthsDue(id)>0) return toast('Clear dues first','error');
    const v=parseInt(document.getElementById('pay-advance-'+id).value);
    if(!v||v<1||v>12) return toast('Enter 1\u201312 months','error');
    const amt=v*t.fee;
    if(!await confirm2('Advance Payment',`Pay <strong style="color:#f0f0f8">${fmt(amt)}</strong> advance for <strong style="color:#f0f0f8">${v} month${v>1?'s':''}</strong> to ${t.name}?<br><small style="color:var(--muted)">No dues for next ${v} month${v>1?'s':''}</small>`,'Pay',_CI.adv)) return;
    const newPay3={teacherId:id,teacherName:t.name,subject:t.subject,monthsPaid:v,advanceMonths:v,amount:amt,type:'advance',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){
      newPay3.id='local_'+Date.now(); payments.push(newPay3); saveToCache();
      toast(`Advance ${fmt(amt)} queued — syncs online`,'success');
      addDoc(pyCol(),newPay3).catch(()=>{});
    } else {
      const fref3=await addDoc(pyCol(),newPay3); newPay3.id=fref3.id; payments.push(newPay3); saveToCache();
      try { idbSet('_lastSyncTs', null); } catch(e){}
      toast(`Advance ${fmt(amt)} paid ✓`,'success');
    }
    setTimeout(updateTotalCard, 100);
  }
  render();
  } finally { release(); }
};

window.deletePayment=async function(id){
  if(!await confirm2('Delete Payment','This cannot be undone.','Delete',_CI.del)) return;
  try{
    await deleteDoc(pyDoc(id));
    payments=payments.filter(p=>p.id!==id); saveToCache();
    try { idbSet('_lastSyncTs', null); } catch(e){}
    toast('Deleted',''); render();
  }catch(e){ toast('Error: '+e.message,'error'); }
};
window.deleteTeacher=async function(id){
  const t=teachers[id]; if(!t) return;
  if(!await confirm2('Remove Teacher',`Remove <strong style="color:#f0f0f8">${t.name}</strong> and all history?`,'Remove',_CI.rem)) return;
  try{
    await Promise.all(payments.filter(p=>p.teacherId===id).map(p=>deleteDoc(pyDoc(p.id))));
    await deleteDoc(tcDoc(id));
    payments=payments.filter(p=>p.teacherId!==id); delete teachers[id]; saveToCache();
    try { idbSet('_lastSyncTs', null); } catch(e){}
    toast(`${t.name} removed`,''); render();
  }catch(e){ toast('Error: '+e.message,'error'); }
};
window.deleteBatch=async function(id){
  const b=batches[id];
  if(!b) return;
  if(!await confirm2('Remove Batch',`Remove <strong style="color:#f0f0f8">${b.name}</strong>?`,'Remove',_CI.rem)) return;
  try {
    await deleteDoc(btDoc(id));
    delete batches[id];
    saveToCache();
    try { idbSet('_lastSyncTs', null); idbSet('_batchDetailTs_'+id, null); } catch(e){}
    toast(`${b.name} removed`,'');
    render();
  } catch(e) { toast('Error: '+e.message,'error'); }
};

function openAddModal(){
  if(isT()){
    
    document.getElementById('teacherAddChoiceSheet').classList.remove('hidden');
    return;
  }
  
  document.getElementById('addModalTitle').textContent='Add Teacher';
  document.getElementById('addStudentFields').classList.remove('hidden');
  document.getElementById('addTeacherFields').classList.add('hidden');
  const _di=document.getElementById('f-lastpaid');
  if(_di){const _n=new Date(),_p=new Date(_n.getFullYear(),_n.getMonth()-1,1);
    _di.value=`${_p.getFullYear()}-${String(_p.getMonth()+1).padStart(2,'0')}-01`;}
  openModal('addModal');
}
function openAddBatchModal(){
  document.getElementById('teacherAddChoiceSheet').classList.add('hidden');
  
  document.getElementById('addStudentFields').classList.add('hidden');
  document.getElementById('addTeacherFields').classList.remove('hidden');
  document.getElementById('addModalTitle').textContent = 'Add Batch';
  ['b-name','b-subject','b-class','b-session','b-fee','b-timing'].forEach(i=>{ const e=document.getElementById(i); if(e) e.value=''; });
  const cb=document.getElementById('confirmAddBtn'); if(cb){cb.disabled=false;cb.textContent='Add';}
  openModal('addModal');
  setTimeout(()=>document.getElementById('b-name')?.focus(),250);
}
function closeAddModal(){
  closeModal('addModal');
  ['f-name','f-subject','f-fee','f-lastpaid','b-name','b-subject','b-class','b-session','b-fee','b-timing']
    .forEach(i=>{ const e=document.getElementById(i); if(e) e.value=''; });
  
  document.getElementById('addStudentFields')?.classList.remove('hidden');
  document.getElementById('addTeacherFields')?.classList.add('hidden');
}
async function confirmAdd(){
  const btn = document.getElementById('confirmAddBtn');
  if (btn.disabled) return; 
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
  if(isT()){
    const nm=document.getElementById('b-name').value.trim();
    const sb=document.getElementById('b-subject').value.trim();
    const cl=document.getElementById('b-class').value.trim();
    const ss=document.getElementById('b-session').value.trim();
    const fe=parseInt(document.getElementById('b-fee').value);
    const ti=document.getElementById('b-timing').value.trim();
    if(!nm||!sb||!fe){ toast('Batch name, subject & fee required','error'); return; }
    const bref=await addDoc(btCol(),{name:nm,subject:sb,class:cl,session:ss,fee:fe,timing:ti,createdAt:Date.now()});
    batches[bref.id]={name:nm,subject:sb,class:cl,session:ss,fee:fe,timing:ti,createdAt:Date.now()}; saveToCache();
    closeAddModal(); render(); toast(`${nm} added ✓`,'success');
  } else {
    const nm=document.getElementById('f-name').value.trim();
    const sb=document.getElementById('f-subject').value.trim();
    const fe=parseInt(document.getElementById('f-fee').value);
    if(!nm||!sb||!fe){ toast('Fill name, subject and fee','error'); return; }
    const dv=document.getElementById('f-lastpaid').value;
    const now2=new Date();
    const _prev=new Date(now2.getFullYear(),now2.getMonth()-1,1);
    const mo=dv?parseInt(dv.split('-')[1]):(_prev.getMonth()+1);
    const yr=dv?parseInt(dv.split('-')[0]):_prev.getFullYear();
    const tref=await addDoc(tcCol(),{name:nm,subject:sb,fee:fe,baselineMonth:mo,baselineYear:yr,lastPaidDate:dv||null});
    teachers[tref.id]={name:nm,subject:sb,fee:fe,baselineMonth:mo,baselineYear:yr,lastPaidDate:dv||null}; saveToCache();
    closeAddModal(); toast(`${nm} added ✓`,'success');
  }
  render();
  } catch(e) { toast('Error: '+e.message,'error'); }
  finally { btn.disabled = false; btn.textContent = 'Add'; }
}

window.toggleHistory=function(id){
  document.getElementById('hist-'+id).classList.toggle('open');
  document.getElementById('tog-'+id).classList.toggle('open');
};

async function _refreshConnectNotif() {
  if (!isT()) return;
  
  if (!_cooldown('connectNotif', _CONNECT_NOTIF_TTL)) return;
  try {
    const dot = document.getElementById('connectIconWrap');
    const sub = document.getElementById('connectNotifSub');
    if (!dot || !sub) return;
    const profileSnap = await getDoc(doc(_db1, 'profiles', cu.uid));
    if (!profileSnap.exists()) {
      dot.classList.add('has-notif');
      sub.textContent = 'Create your public profile';
      sub.classList.remove('hidden');
      return;
    }
    const reqSnap = await getDocs(
      query(collection(_db1, 'connections'),
            where('teacherId', '==', cu.uid),
            where('status', '==', 'pending'))
    );
    if (reqSnap.empty) {
      dot.classList.remove('has-notif');
      sub.classList.add('hidden');
      return;
    }
    dot.classList.add('has-notif');
    const first = reqSnap.docs[0].data();
    const extra = reqSnap.size > 1 ? ` +${reqSnap.size - 1} more` : '';
    const cls   = first.studentClass ? ` · ${first.studentClass}` : '';
    sub.textContent = `${first.studentName||'Student'}${cls}${extra} wants to join`;
    sub.classList.remove('hidden');
  } catch {}
}
window._refreshConnectNotif = _refreshConnectNotif;

let sx=0;
window.startSwipe=(e,el)=>{
  sx=e.touches[0].clientX;
  el.style.transition='none';
  el._origBg = el.style.background || '';
};
window.moveSwipe=(e,el)=>{
  const d=e.touches[0].clientX-sx;
  if(d<0){
    el.style.transform=`translateX(${Math.max(d,-el.offsetWidth)}px)`;
    const pct=Math.min(Math.abs(d)/100,1);
    el.style.background=`rgba(255,77,109,${pct*0.35})`;
    
    if(!el._delHint){
      el._delHint=document.createElement('div');
      el._delHint.textContent='✕';
      el._delHint.style.cssText='position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:16px;opacity:0;transition:opacity .15s;pointer-events:none;';
      el.appendChild(el._delHint);
    }
    el._delHint.style.opacity=pct>0.6?'1':'0';
  }
};
window.endSwipe=(el,id)=>{
  const gone=Math.abs(parseFloat(el.style.transform.replace('translateX(',''))||0);
  if(el._delHint){ el._delHint.remove(); el._delHint=null; }
  if(gone>80){
    el.style.transition='transform .2s, opacity .2s';
    el.style.transform=`translateX(-${el.offsetWidth}px)`;
    el.style.opacity='0';
    setTimeout(()=>window.deletePayment(id),200);
  } else {
    el.style.transition='transform .22s cubic-bezier(.34,1.3,.64,1), background .2s';
    el.style.transform='translateX(0)';
    el.style.background=el._origBg||'';
  }
};

let py=0,pu=false;
const pi=document.getElementById('pull-indicator');
const _appScr=document.getElementById('appScreen');
let _ptStartX=0;
document.addEventListener('touchstart',e=>{
  const atTop = _appScr ? _appScr.scrollTop===0 : window.scrollY===0;
  if(atTop){
    py=e.touches[0].clientY; _ptStartX=e.touches[0].clientX; pu=true;
  } else { pu=false; }
},{passive:true});
document.addEventListener('touchmove',e=>{
  if(!pu||!pi) return;
  const dx=Math.abs(e.touches[0].clientX-_ptStartX);
  const dy=e.touches[0].clientY-py;
  if(dx>dy*0.7){ pu=false; pi.style.transform='translateY(-100%)'; return; }
  if(dy>8){
    pi.style.transform=`translateY(${Math.min(dy-8,56)}px)`;
    pi.textContent=dy>72?'\u2191 Release to refresh':'\u2193 Pull to refresh';
  }
},{passive:true});
document.addEventListener('touchend',async e=>{
  if(!pu) return; pu=false;
  if(!pi) return;
  const dy=e.changedTouches[0].clientY-py;
  pi.style.transform='translateY(-100%)';
  if(dy>72){
    if (!_cooldown('pullRefresh', 30000)) {
      toast('Just refreshed',''); return;
    }
    pi.textContent='\u27f3 Refreshing\u2026';
    pi.style.transform='translateY(0)';
    await loadAll(true, true);
    toast('Refreshed \u2713','success');
    setTimeout(()=>{pi.style.transform='translateY(-100%)';},700);
  }
},{passive:true});

const _renderCardsDebounced = _debounce(function(cursorPos) {
  renderCards();
  const inp2 = document.querySelector('.search-input');
  if (inp2) { inp2.focus(); if (cursorPos !== null) try { inp2.setSelectionRange(cursorPos, cursorPos); } catch(e) {} }
}, 150);

window.onSearch = function(v) {
  searchQ = v;
  const _ai = document.getElementById('appInner');
  if (_ai) { if (v) { _ai.classList.add('search-active'); } else { _ai.classList.remove('search-active'); } }
  document.body.classList.toggle('searching', v.length > 0);
  const inp = document.querySelector('.search-input');
  const cursorPos = inp ? inp.selectionStart : null;
  _renderCardsDebounced(cursorPos);
};

function toggleMenu(e){ e?.stopPropagation(); const m=document.getElementById('userMenu'),b=document.getElementById('menuBackdrop'),isHidden=m.classList.contains('hidden'); if(isHidden){ m.style.animation='none'; m.classList.remove('hidden'); void m.offsetWidth; m.style.animation=''; b.classList.remove('hidden'); updateMenuThemeLabel(); } else { m.classList.add('hidden'); b.classList.add('hidden'); } }
function closeMenu(){ document.getElementById('userMenu').classList.add('hidden'); document.getElementById('menuBackdrop').classList.add('hidden'); }

function screenTo(showId, hideId, direction='right') {
  const show = document.getElementById(showId);
  const hide = document.getElementById(hideId);
  if (!show || !hide) return;

  const xSign = direction === 'right' ? 1 : -1;

  hide.style.transition   = 'opacity .22s ease, transform .22s cubic-bezier(.4,0,.6,1)';
  hide.style.transform    = `translateX(${xSign * -32}px)`;
  hide.style.opacity      = '0';
  hide.style.pointerEvents = 'none';

  show.classList.remove('hidden');
  show.style.transition = '';
  show.style.transform  = `translateX(${xSign * 32}px)`;
  show.style.opacity    = '0';
  void show.offsetHeight; 

  show.style.transition = 'opacity .26s ease, transform .26s cubic-bezier(.25,.85,.35,1)';
  show.style.transform  = 'translateX(0)';
  show.style.opacity    = '1';

  setTimeout(() => {
    hide.classList.add('hidden');
    hide.style.transition = '';
    hide.style.transform  = '';
    hide.style.opacity    = '';
    hide.style.pointerEvents = '';

    show.style.transition = '';
    show.style.transform  = '';
    show.style.opacity    = '';
  }, 280);
}

function screenFadeTo(showId, hideId) {
  const show = document.getElementById(showId);
  const hide = document.getElementById(hideId);
  if (!show || !hide) return;

  hide.style.transition = 'opacity .18s ease';
  hide.style.opacity    = '0';
  hide.style.pointerEvents = 'none';

  setTimeout(() => {
    hide.classList.add('hidden');
    hide.style.transition = '';
    hide.style.opacity    = '';
    hide.style.pointerEvents = '';

    show.classList.remove('hidden');
    show.style.opacity    = '0';
    show.style.transition = '';
    
    void show.offsetHeight;
    show.style.transition = 'opacity .2s ease';
    show.style.opacity    = '1';
    setTimeout(() => {
      show.style.transition = '';
      show.style.opacity    = '';
    }, 210);
  }, 190);
}

function openModal(overlayId) {
  const el = document.getElementById(overlayId);
  if (el) el.classList.remove('hidden');
}

function closeModal(overlayId) {
  const el = document.getElementById(overlayId);
  if (el) el.classList.add('hidden');
}

function staggerChildren(container, selector, baseDelay=0, step=0.05, max=0.35) {
  const items = container?.querySelectorAll(selector);
  if (!items) return;
  items.forEach((el, i) => {
    el.style.animationDelay = Math.min(baseDelay + i * step, max) + 's';
  });
}

function addRipple(el, e) {
  const rect = el.getBoundingClientRect();
  const x = (e.clientX || rect.left + rect.width/2) - rect.left;
  const y = (e.clientY || rect.top  + rect.height/2) - rect.top;
  const size = Math.max(rect.width, rect.height) * 1.6;
  const r = document.createElement('span');
  r.className = 'tap-ripple';
  r.style.cssText = `width:${size}px;height:${size}px;left:${x - size/2}px;top:${y - size/2}px`;
  el.style.position = el.style.position || 'relative';
  el.style.overflow = 'hidden';
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove(), { once: true });
}

function render(){
  appRendered = true;
  if(isT()){ if(typeof window.renderTeacher==="function") window.renderTeacher(); else renderTeacher(); }
  else { if(typeof window.renderStudent==="function") window.renderStudent(); else renderStudent(); }
  
  const _db=document.getElementById('dashBtn');
  if(_db) _db.classList.remove('hidden');
  
  window._searchPlaceholderReset?.();
  
  setTimeout(_applyCurSymbol, 30);
  setTimeout(runTotalCountUp, 60);
}

function renderCards(){
  if(isT()) return; 
  const container=document.getElementById('cards-list');
  if(!container){ render(); return; } 

  const countEl=document.getElementById('teachers-count');
  if(countEl) countEl.textContent=Object.keys(teachers).length;

  if(!Object.keys(teachers).length){
    container.innerHTML=`<div class="empty-state"><div class="empty-icon" style="display:flex;align-items:center;justify-content:center;margin-bottom:14px;"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="6" y="6" width="4" height="40" rx="2" fill="currentColor" opacity=".3"/></svg></div><div class="empty-title">No teachers yet</div><div class="empty-sub">Tap <strong>+</strong> to add your first teacher and start tracking.</div></div>`;
    return;
  }
  const sorted=Object.keys(teachers).sort((a,b)=>calcDue(b)-calcDue(a)).filter(id=>{ const q=searchQ.toLowerCase(); return !q||teachers[id].name.toLowerCase().includes(q)||teachers[id].subject.toLowerCase().includes(q); });
  if(!sorted.length){
    container.innerHTML=`<div class="no-results">No results for "<strong>${searchQ}</strong>"</div>`;
    return;
  }
  let h='', dl=0;
  
  const _paysByTeacher = {};
  payments.forEach(p => { (_paysByTeacher[p.teacherId] = _paysByTeacher[p.teacherId] || []).push(p); });
  for(const id of sorted){
    const t=teachers[id], dm=monthsDue(id), da=calcDue(id), lps=lastPaidStr(id), ov2=dm>=3, cr=dm>=6, pb=partialBal(id);
    const tpy=(_paysByTeacher[id]||[]).sort((a,b)=>b.timestamp-a.timestamp);
    const bdg=cr?`<span class="overdue-badge critical"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".7" fill="currentColor"/></svg>${dm}mo</span>`:ov2?`<span class="overdue-badge"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".65" fill="currentColor"/></svg>${dm}mo</span>`:'';
    h+=`<div class="teacher-card ${cr?'card-critical':ov2?'card-overdue':''}" data-id="${id}" style="animation-delay:${dl}s"
      onclick="if(selMode){event.stopPropagation();selTap('${id}');return;}openTeacherDetail('${id}')">
      <div class="card-top">
        <div class="card-header">
          <div class="card-left">
            <div class="teacher-name-row"><div class="teacher-name">${t.name}</div>${bdg}</div>
            <div class="teacher-subject">${t.subject} · ${fmt(t.fee)}/mo</div>
            ${lps?`<div class="last-paid">Last paid: ${lps}</div>`:`<div class="last-paid never">Never paid</div>`}
          </div>
          <div class="due-badge">
            <div class="due-amount ${da===0?'zero':cr?'critical':''}">${fmt(da)}</div>
            <div class="due-months">${dm===0?'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>All clear':`${dm} month${dm>1?'s':''} due`}</div>
            ${pb>0?`<div class="partial-chip">+${fmt(pb)} partial</div>`:''}
          </div>
        </div>
      </div>
      <div class="tc-tap-hint">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6 8h4M8 6v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Tap to pay, view history &amp; more
      </div>
    <div class="card-chevron"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    </div>`;
    dl+=0.05;
  }
  container.innerHTML=h;
  // Re-apply active status filter after card rebuild (search path)
  const activeFilter = window._activeStatusFilter;
  if(activeFilter && activeFilter !== 'all') {
    window.filterByStatus(activeFilter);
  } else if(typeof _applyMetaHighlight === 'function') {
    _applyMetaHighlight('all');
  }
}

function renderStudent(){
  const root=document.getElementById('appInner');
  const td=totalDue(), n=new Date();
  const ds=n.toLocaleDateString(USER_LOCALE,{day:'numeric',month:'long',year:'numeric'});
  const ov=Object.keys(teachers).filter(id=>monthsDue(id)>0).length;
  const cl=Object.keys(teachers).filter(id=>monthsDue(id)===0).length;
  let h=`
    ${!profile.className?`<div class="setup-banner" onclick="openProfileModal()"><span class="setup-banner-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><circle cx="9" cy="6" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M2 16c0-3.9 3.1-6 7-6s7 2.1 7 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><div class="setup-banner-text"><div class="setup-banner-title">Complete your profile</div><div class="setup-banner-sub">Add your name and class</div></div><button class="setup-banner-btn">Set up</button></div>`:''}
    <div class="total-card" id="totalCard" style="cursor:pointer" onclick="handleTotalCardClick(event)">
      <div class="total-label">Total Outstanding</div>
      <div class="total-amount"><span class="cur"></span><span id="totalAmtDisplay" data-target="${td}">0</span></div>
      <div class="total-sub" id="totalDateSub">As of ${ds}</div>
      <div class="total-meta" id="totalMeta">
        <div class="total-meta-item total-meta-item--pending" id="metaPending" onclick="event.stopPropagation();filterByStatus('pending')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show pending teachers">
          <div class="total-meta-val" id="metaPendingVal">${ov}</div>
          <div class="total-meta-lbl">Pending</div>
        </div>
        <div class="total-meta-item total-meta-item--clear" id="metaClear" onclick="event.stopPropagation();filterByStatus('clear')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show clear teachers">
          <div class="total-meta-val" id="metaClearVal">${cl}</div>
          <div class="total-meta-lbl">Clear</div>
        </div>
        <div class="total-meta-item total-meta-item--all" id="metaAll" onclick="event.stopPropagation();filterByStatus('all')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show all teachers">
          <div class="total-meta-val" id="metaAllVal">${Object.keys(teachers).length}</div>
          <div class="total-meta-lbl">Teachers</div>
        </div>
      </div>
    </div>
    <div class="search-wrap">
      <span class="search-icon"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg></span>
      <input class="search-input" type="text" placeholder="Search teacher or subject\u2026" value="${searchQ}" oninput="onSearch(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}" />
      ${searchQ?`<span class="search-clear" onclick="onSearch('');document.querySelector('.search-input').value='';" style="display:flex;align-items:center;justify-content:center;cursor:pointer;"><svg width='11' height='11' viewBox='0 0 12 12' fill='none' style='display:block'><line x1='1' y1='1' x2='11' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/><line x1='11' y1='1' x2='1' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/></svg></span>`:''}
    <div class="section-label"><span class="section-label-txt">Teachers</span><span class="section-label-count" id="teachers-count">${Object.keys(teachers).length}</span></div>
    <div id="cards-list">`;

  if(!Object.keys(teachers).length){
    h+=`<div class="empty-state"><div class="empty-icon" style="display:flex;align-items:center;justify-content:center;margin-bottom:14px;"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div><div class="empty-title">No teachers yet</div><div class="empty-sub">Tap <strong>+</strong> to add your first teacher and start tracking.</div></div>`;
    root.innerHTML=h; return;
  }
  const sorted=Object.keys(teachers).sort((a,b)=>calcDue(b)-calcDue(a)).filter(id=>{ const q=searchQ.toLowerCase(); return !q||teachers[id].name.toLowerCase().includes(q)||teachers[id].subject.toLowerCase().includes(q); });
  if(!sorted.length){ h+=`<div class="no-results">No results for "<strong>${searchQ}</strong>"</div></div>`; root.innerHTML=h; return; }

  let dl=0;
  
  const _pbtRS = {};
  payments.forEach(p => { (_pbtRS[p.teacherId] = _pbtRS[p.teacherId] || []).push(p); });
  for(const id of sorted){
    const t=teachers[id], dm=monthsDue(id), da=calcDue(id), lps=lastPaidStr(id), ov2=dm>=3, cr=dm>=6, pb=partialBal(id);
    const tpy=(_pbtRS[id]||[]).sort((a,b)=>b.timestamp-a.timestamp);
    const bdg=cr?`<span class="overdue-badge critical"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".7" fill="currentColor"/></svg>${dm}mo</span>`:ov2?`<span class="overdue-badge"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".65" fill="currentColor"/></svg>${dm}mo</span>`:'';
    h+=`<div class="teacher-card ${cr?'card-critical':ov2?'card-overdue':''}" data-id="${id}" style="animation-delay:${dl}s"
      onclick="if(selMode){event.stopPropagation();selTap('${id}');return;}openTeacherDetail('${id}')">
      <div class="card-top">
        <div class="card-header">
          <div class="card-left">
            <div class="teacher-name-row"><div class="teacher-name">${t.name}</div>${bdg}</div>
            <div class="teacher-subject">${t.subject} · ${fmt(t.fee)}/mo</div>
            ${lps?`<div class="last-paid">Last paid: ${lps}</div>`:`<div class="last-paid never">Never paid</div>`}
          </div>
          <div class="due-badge">
            <div class="due-amount ${da===0?'zero':cr?'critical':''}">${fmt(da)}</div>
            <div class="due-months">${dm===0?'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>All clear':`${dm} month${dm>1?'s':''} due`}</div>
            ${pb>0?`<div class="partial-chip">+${fmt(pb)} partial</div>`:''}
          </div>
        </div>
      </div>
      <div class="tc-tap-hint">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6 8h4M8 6v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Tap to pay, view history &amp; more
      </div>
    </div>`;
    dl=Math.min(dl+0.05, 0.3);
  }
  h+='</div>';
  root.innerHTML=h;
}

// TEACHER: BATCH + STUDENT + PAYMENT SYSTEM
let currentBatchId=null, batchStudents={}, batchPayments=[];
const stuCol=bid=>collection(db,'users',uid(),'batches',bid,'students');
const stuDoc=(bid,sid)=>doc(db,'users',uid(),'batches',bid,'students',sid);
const bpyCol=bid=>collection(db,'users',uid(),'batches',bid,'payments');
const bpyDoc=(bid,pid)=>doc(db,'users',uid(),'batches',bid,'payments',pid);
const sFee=bid=>batches[bid]?.fee||0;
function sLastPaid(bid,sid){
  const fee=sFee(bid),st=batchStudents[sid];
  const _sn=new Date(),_sp=new Date(_sn.getFullYear(),_sn.getMonth()-1,1);
  let seedDay=1;
  if(st.lastPaidDate){const pp=st.lastPaidDate.split('-');if(pp[2])seedDay=parseInt(pp[2])||1;}
  let lp={month:st.baselineMonth||(_sp.getMonth()+1),year:st.baselineYear||_sp.getFullYear(),day:seedDay},rp=0;
  batchPayments.filter(p=>p.studentId===sid).sort((a,b)=>a.timestamp-b.timestamp).forEach(p=>{
    if(p.type==='partial'){rp+=p.amount;const cc=Math.floor(rp/fee);if(cc>0){lp=addM(lp,cc);lp.day=p.paidOn?.day||lp.day;rp%=fee;}}
    else if(p.monthsPaid){lp=addM(lp,p.monthsPaid);lp.day=p.paidOn?.day||1;rp=0;}
  });return lp;
}
function sPartialBal(bid,sid){const fee=sFee(bid);let cc=0;
  batchPayments.filter(p=>p.studentId===sid).sort((a,b)=>a.timestamp-b.timestamp)
    .forEach(p=>{if(p.type==='partial'){cc+=p.amount;cc%=fee;}else if(p.monthsPaid)cc=0;});return cc;}
function sMonthsDue(bid,sid){const n=new Date(),lp=sLastPaid(bid,sid);let m=mBetween(lp,{month:n.getMonth()+1,year:n.getFullYear()});if(m>0&&n.getDate()<(lp.day||1))m--;return Math.max(m,0);}
function sCalcDue(bid,sid){const fee=sFee(bid),mo=sMonthsDue(bid,sid);return mo?Math.max(mo*fee-sPartialBal(bid,sid),0):0;}
function sTotalDue(bid){return Object.keys(batchStudents).reduce((s,sid)=>s+sCalcDue(bid,sid),0);}
function sLastPaidStr(sid){const tp=batchPayments.filter(p=>p.studentId===sid).sort((a,b)=>b.timestamp-a.timestamp);
  if(!tp.length)return null;const p=tp[0];return p.paidOn?`${p.paidOn.day} ${MONTHS[p.paidOn.month-1]} ${p.paidOn.year}`:null;}

window.switchSPayTab=function(sid,type){
  if(document.getElementById(`sptab-${type}-${sid}`)?.disabled)return;
  ['full','partial','advance'].forEach(t=>{
    document.getElementById(`sprow-${t}-${sid}`)?.classList.toggle('hidden',t!==type);
    const el=document.getElementById(`sptab-${t}-${sid}`);
    if(el){el.classList.remove('active','active-partial','active-advance');
      if(t===type)el.classList.add(t==='partial'?'active-partial':t==='advance'?'active-advance':'active');}
  });};

window.sPayMonths=async function(bid,sid,type){
  const release = await _writeLock('spay_'+sid);
  try {
  const fee=sFee(bid),st=batchStudents[sid];
  const n=new Date(),po={day:n.getDate(),month:n.getMonth()+1,year:n.getFullYear()};
  if(type==='full'){
    const max=sMonthsDue(bid,sid);if(!max)return toast('No dues \u2713','success');
    const v=parseInt(document.getElementById('spay-'+sid).value);
    if(!v||v<1||v>max)return toast('Enter 1\u2013'+max,'error');
    const amt=v*fee;
    if(!await confirm2('Mark Payment',`<strong style="color:#f0f0f8">${st.name}</strong><br>${fmt(amt)} \u00b7 ${v} month${v>1?'s':''}?`,'Mark',_CI.pay))return;
    const _sp1={studentId:sid,studentName:st.name,monthsPaid:v,amount:amt,type:'full',paidOn:po,timestamp:Date.now(),batchId:bid};
    if(!navigator.onLine){ _sp1.id='local_'+Date.now(); payments.push(_sp1); batchPayments.push(_sp1); saveToCache(); addDoc(bpyCol(bid),_sp1).catch(()=>{}); }
    else { const _sr1=await addDoc(bpyCol(bid),_sp1); _sp1.id=_sr1.id; payments.push(_sp1); batchPayments.push(_sp1); saveToCache(); _invalidateBatchCache(bid); }
    document.getElementById('spay-'+sid).value='';toast(fmt(amt)+' marked \u2713','success');
  }else if(type==='partial'){
    const amt=parseInt(document.getElementById('spay-partial-'+sid).value);
    if(!amt||amt<1)return toast('Enter amount','error');if(amt>=fee)return toast('Use Full tab','error');
    const tot=sPartialBal(bid,sid)+amt;if(tot>=fee)return toast('Use Full tab instead','error');
    if(!await confirm2('Partial Payment',`<strong style="color:#f0f0f8">${st.name}</strong><br>${fmt(amt)} partial<br><small style="color:var(--muted)">Still owed: ${fmt((fee-tot))}</small>`,'Mark',_CI.part))return;
    const _sp2={studentId:sid,studentName:st.name,amount:amt,type:'partial',paidOn:po,timestamp:Date.now(),batchId:bid};
    if(!navigator.onLine){ _sp2.id='local_'+Date.now(); payments.push(_sp2); batchPayments.push(_sp2); saveToCache(); addDoc(bpyCol(bid),_sp2).catch(()=>{}); }
    else { const _sr2=await addDoc(bpyCol(bid),_sp2); _sp2.id=_sr2.id; payments.push(_sp2); batchPayments.push(_sp2); saveToCache(); _invalidateBatchCache(bid); }
    document.getElementById('spay-partial-'+sid).value='';toast('Partial '+fmt(amt)+' recorded','success');
  }else if(type==='advance'){
    if(sMonthsDue(bid,sid)>0)return toast('Clear dues first','error');
    const v=parseInt(document.getElementById('spay-advance-'+sid).value);
    if(!v||v<1||v>12)return toast('Enter 1\u201312','error');const amt=v*fee;
    if(!await confirm2('Advance Payment',`<strong style="color:#f0f0f8">${st.name}</strong><br>${fmt(amt)} \u00b7 ${v} month${v>1?'s':''} ahead?`,'Mark',_CI.adv))return;
    const _sp3={studentId:sid,studentName:st.name,monthsPaid:v,advanceMonths:v,amount:amt,type:'advance',paidOn:po,timestamp:Date.now(),batchId:bid};
    if(!navigator.onLine){ _sp3.id='local_'+Date.now(); payments.push(_sp3); batchPayments.push(_sp3); saveToCache(); addDoc(bpyCol(bid),_sp3).catch(()=>{}); }
    else { const _sr3=await addDoc(bpyCol(bid),_sp3); _sp3.id=_sr3.id; payments.push(_sp3); batchPayments.push(_sp3); saveToCache(); _invalidateBatchCache(bid); }
    document.getElementById('spay-advance-'+sid).value='';toast('Advance '+fmt(amt)+' ✓','success');
  }
  await loadBatchDetail(bid);
  } finally { release(); }
};

window.deleteStudentPayment=async function(bid,pid){
  if(!await confirm2('Delete Payment','Cannot be undone.','Delete',_CI.del))return;
  try{
    await deleteDoc(bpyDoc(bid,pid)); _invalidateBatchCache(bid); toast('Deleted',''); await loadBatchDetail(bid);
  }catch(e){ toast('Error: '+e.message,'error'); }
};
window.deleteStudent=async function(bid,sid){
  const st=batchStudents[sid]; if(!st) return;
  if(!await confirm2('Remove Student',`Remove <strong style="color:#f0f0f8">${st.name}</strong>?`,'Remove',_CI.del))return;
  try{
    await Promise.all(batchPayments.filter(p=>p.studentId===sid).map(p=>deleteDoc(bpyDoc(bid,p.id))));
    await deleteDoc(stuDoc(bid,sid)); _invalidateBatchCache(bid); toast(st.name+' removed',''); await loadBatchDetail(bid);
  }catch(e){ toast('Error: '+e.message,'error'); }
};
window.toggleStudentHist=function(sid){
  document.getElementById('shist-'+sid)?.classList.toggle('open');
  document.getElementById('stog-'+sid)?.classList.toggle('open');};
window.endStudentSwipe=(el,bid,pid)=>{
  const moved=Math.abs(el.getBoundingClientRect().left-el.parentElement.getBoundingClientRect().left);
  if(moved>80)window.deleteStudentPayment(bid,pid);
  else{el.style.transition='transform .2s';el.style.transform='translateX(0)';el.style.background='';}};

async function loadBatchDetail(bid){
  currentBatchId=bid;
  // ── TTL gate — use IDB cache if detail was synced within last 3 minutes ──
  try {
    const batchTs = await idbGet('_batchDetailTs_'+bid);
    if (batchTs && (Date.now() - batchTs) < 3 * 60 * 1000) {
      const cached = await loadBatchDetailFromCache(bid);
      if (cached) {
        batchStudents = cached.students || {};
        batchPayments = cached.payments || [];
        renderBatchDetail(bid);
        return;
      }
    }
  } catch(e) { /* proceed with Firestore fetch */ }
  try {
    const [sSnap,pSnap]=await Promise.all([getDocs(stuCol(bid)),getDocs(bpyCol(bid))]);
    batchStudents={};sSnap.forEach(d=>{batchStudents[d.id]=d.data();});
    batchPayments=pSnap.docs.map(d=>({id:d.id,...d.data()}));
    // Cache immediately after every successful fetch
    saveBatchDetailToCache(bid);
  } catch(e) {
    // Offline or fetch failed — try IDB cache

    const cached = await loadBatchDetailFromCache(bid);
    if(cached){
      batchStudents = cached.students || {};
      batchPayments = cached.payments || [];
      if (!navigator.onLine) showOfflineBanner(true);
    } else {
      batchStudents = {}; batchPayments = [];
      toast('No cached data for this batch', 'error');
    }
  }
  renderBatchDetail(bid);
}

function renderBatchDetail(bid){
  const root = document.getElementById('bdBody');
  const sIds = Object.keys(batchStudents);
  const pending = sIds.filter(sid => sMonthsDue(bid, sid) > 0).length;
  const bName = batches[bid]?.name || '';
  const bFee  = batches[bid]?.fee  || 0;
  const totalDueAmt = sIds.reduce((s,sid) => s + sCalcDue(bid,sid), 0);
  let h = `<div class="bd-summary-card">
      <div class="bd-sum-main">
        <div>
          <div class="bd-sum-label">Outstanding</div>
          <div class="bd-sum-amount" style="color:#fff">${fmt(totalDueAmt)}</div>
        </div>
      </div>
      <div class="bd-sum-meta">
      <div class="bd-sum-pill"><div class="bd-sum-pill-val">${sIds.length}</div><div class="bd-sum-pill-lbl">Students</div></div>
      <div class="bd-sum-pill"><div class="bd-sum-pill-val">${pending}</div><div class="bd-sum-pill-lbl">Pending</div></div>
      <div class="bd-sum-pill"><div class="bd-sum-pill-val">${sIds.length-pending}</div><div class="bd-sum-pill-lbl">Clear</div></div>
    </div></div>
    <div class="section-label" style="margin-bottom:12px;"><span class="section-label-txt">Students</span><span class="section-label-count">${sIds.length}</span></div>`;
  if(!sIds.length){h+=`<div class="empty-state"><div class="empty-icon"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M26 11L8 21l18 10 18-10L26 11z" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 25v8c0 4 5.8 7.5 13 7.5S39 37 39 33v-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="44" y1="21" x2="44" y2="31" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="44" cy="33" r="2.2" fill="currentColor"/></svg></div><div class="empty-title">No students yet</div><div class="empty-sub">Tap <strong>+</strong> above to add students.</div></div>`;root.innerHTML=h;return;}
  sIds.sort((a,b)=>sCalcDue(bid,b)-sCalcDue(bid,a));
  let dl=0;
  for(const sid of sIds){
    const st=batchStudents[sid],dm=sMonthsDue(bid,sid),da=sCalcDue(bid,sid);
    const pb=sPartialBal(bid,sid),lps=sLastPaidStr(sid),fee=sFee(bid),ov=dm>=3,cr=dm>=6;
    const pays=batchPayments.filter(p=>p.studentId===sid).sort((a,b)=>b.timestamp-a.timestamp);
    const init=st.name.trim().split(/\s+/).map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
    const odB=cr?`<span class="sc-overdue-badge crit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".7" fill="currentColor"/></svg>${dm}mo</span>`:ov?`<span class="sc-overdue-badge"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".65" fill="currentColor"/></svg>${dm}mo</span>`:'';
    h+=`<div class="student-card ${cr?'sc-critical':ov?'sc-overdue':''}" style="animation-delay:${dl}s">
      <div class="sc-top"><div class="sc-header">
        <div class="sc-left">
          <div class="sc-name-row"><div class="sc-avatar">${init}</div><div class="sc-name">${st.name}</div>${odB}</div>
          <div class="sc-meta">${fmt(fee)}/mo</div>
          ${st.admissionDay?`<div class="sc-admission">Joined: <span>${st.admissionDay} ${MONTHS[st.admissionMonth-1]} ${st.admissionYear}</span></div>`:''}
          ${lps?`<div class="sc-last-paid">Last paid: ${lps}</div>`:`<div class="sc-last-paid never">Never paid</div>`}
        </div>
        <div class="sc-due-badge">
          <div class="sc-due-amt ${da===0?'zero':cr?'crit':''}">${fmt(da)}</div>
          <div class="sc-due-mo">${dm===0?'All clear \u2713':`${dm} month${dm>1?'s':''} due`}</div>
          ${pb>0?`<div class="sc-partial-chip">+${fmt(pb)} partial</div>`:''}
        </div>
      </div>
      <div class="pay-tabs">
        <button class="pay-tab ${dm>0?'active':''}" id="sptab-full-${sid}" onclick="switchSPayTab('${sid}','full')" ${dm===0?'disabled':''}>Full</button>
        <button class="pay-tab" id="sptab-partial-${sid}" onclick="switchSPayTab('${sid}','partial')" ${dm===0?'disabled':''}>Partial</button>
        <button class="pay-tab ${dm===0?'active-advance':''}" id="sptab-advance-${sid}" onclick="switchSPayTab('${sid}','advance')" ${dm>0?'disabled':''}>Advance</button>
      </div>
      <div class="pay-row ${dm===0?'hidden':''}" id="sprow-full-${sid}">
        <input id="spay-${sid}" class="pay-input" type="number" min="1" max="${dm}" placeholder="${dm>1?'Months (1\u2013'+dm+')':dm===1?'1 month due':''}">
        <button class="pay-btn" onclick="sPayMonths('${bid}','${sid}','full')" ${dm===0?'disabled':''}>Mark</button>
      </div>
      <div class="pay-row hidden" id="sprow-partial-${sid}">
        <input id="spay-partial-${sid}" class="pay-input" type="number" min="1" max="${fee-1}" placeholder="\u20b91\u2013\u20b9${fee-1}">
        <button class="pay-btn pay-btn-partial" onclick="sPayMonths('${bid}','${sid}','partial')">Mark</button>
      </div>
      <div class="pay-row ${dm===0?'':'hidden'}" id="sprow-advance-${sid}">
        <input id="spay-advance-${sid}" class="pay-input" type="number" min="1" max="12" placeholder="Months ahead (1\u201312)">
        <button class="pay-btn pay-btn-advance" onclick="sPayMonths('${bid}','${sid}','advance')">Mark</button>
      </div>
      </div>
      <div class="sc-actions">
        <div class="sc-hist-toggle" id="stog-${sid}" onclick="toggleStudentHist('${sid}')">
          <span style="display:inline-flex;align-items:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:block"><circle cx="8" cy="8" r="6" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.4"/><polyline points="8,5 8,8.5 10.5,10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>History (${pays.length})</span><svg width="10" height="10" viewBox="0 0 14 14" fill="none" class="sc-h-arrow" style="display:block;margin-left:auto"><path d="M2 4l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <button class="sc-edit-btn" onclick="openEditStudent('${bid}','${sid}')" title="Edit student"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="sc-del-btn" onclick="deleteStudent('${bid}','${sid}')"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
      </div>
      <div class="sc-hist-panel" id="shist-${sid}">
        ${pays.length===0?'<div class="hist-empty">No payments yet</div>':
          '<div class="swipe-hint">&#x2190; swipe to delete</div>'+pays.map(p=>{
            const hb=p.type==='partial'?'<span class="hist-badge hist-partial">Partial</span>':p.type==='advance'?'<span class="hist-badge hist-advance">Advance</span>':'';
            const lb=p.type==='partial'?`${fmt(p.amount)} partial`:`${p.monthsPaid} month${p.monthsPaid>1?'s':''}`;
            return `<div class="payment-item" ontouchstart="startSwipe(event,this)" ontouchmove="moveSwipe(event,this)" ontouchend="endStudentSwipe(this,'${bid}','${p.id}')"><div><div class="pay-months-txt">${lb}${hb}</div><div class="pay-date-txt">${p.paidOn?`${p.paidOn.day} ${MONTHS[p.paidOn.month-1]} ${p.paidOn.year}`:'--'}</div></div><div class="pay-amt-tag">${fmt(p.amount)}</div></div>`;
          }).join('')}
      </div>
    </div>`;dl=Math.min(dl+0.05,0.3);}
  root.innerHTML=h;}

// ── Edit Student (after save) ─────────────────────────────────────────────
let _editStuBid='',_editStuSid='';
window.openEditStudent=function(bid,sid){
  _editStuBid=bid; _editStuSid=sid;
  const st=batchStudents[sid];
  document.getElementById('editStudentNameInp').value=st.name||'';
  if(st.admissionYear){const mm=String(st.admissionMonth).padStart(2,'0'),dd=String(st.admissionDay).padStart(2,'0');document.getElementById('editStudentDateInp').value=`${st.admissionYear}-${mm}-${dd}`;}
  else{document.getElementById('editStudentDateInp').value='';}
  const fs=st.feeStatus||'never'; editFeeStatus=fs; window.setEditFeeStatus(fs);
  if(fs==='date'&&st.lastPaidYear){const mm=String(st.lastPaidMonth).padStart(2,'0'),dd=String(st.lastPaidDay).padStart(2,'0');document.getElementById('editStudentLastPaidInp').value=`${st.lastPaidYear}-${mm}-${dd}`;}
  else{const el=document.getElementById('editStudentLastPaidInp');if(el)el.value='';}
  document.getElementById('editStudentModal').classList.remove('hidden');
  setTimeout(()=>document.getElementById('editStudentNameInp').focus(),150);
};
function closeEditStudentModal(){document.getElementById('editStudentModal').classList.add('hidden');}
async function saveEditStudent(){
  const nm=document.getElementById('editStudentNameInp').value.trim();
  if(!nm)return toast('Name cannot be empty','error');
  if(editFeeStatus==='date'&&!document.getElementById('editStudentLastPaidInp').value)return toast('Enter last payment date','error');
  const btn=document.getElementById('saveEditStudentBtn');
  btn.disabled=true;btn.textContent='Saving\u2026';
  try{
    const upd={name:nm,updatedAt:Date.now(),feeStatus:editFeeStatus};
    const dv=document.getElementById('editStudentDateInp').value;
    if(dv){const p=dv.split('-');upd.admissionDay=parseInt(p[2]);upd.admissionMonth=parseInt(p[1]);upd.admissionYear=parseInt(p[0]);}
    else{upd.admissionDay=null;upd.admissionMonth=null;upd.admissionYear=null;}
    if(editFeeStatus==='date'){
      const lpv=document.getElementById('editStudentLastPaidInp').value,lp=lpv.split('-');
      upd.lastPaidDay=parseInt(lp[2]);upd.lastPaidMonth=parseInt(lp[1]);upd.lastPaidYear=parseInt(lp[0]);
      upd.baselineMonth=parseInt(lp[1]);upd.baselineYear=parseInt(lp[0]);
    } else {
      upd.lastPaidDay=null;upd.lastPaidMonth=null;upd.lastPaidYear=null;
      if(dv){const p=dv.split('-'),now=new Date(),aMs=parseInt(p[0])*12+parseInt(p[1]),nMs=now.getFullYear()*12+(now.getMonth()+1);if(aMs<nMs){upd.baselineMonth=parseInt(p[1]);upd.baselineYear=parseInt(p[0]);}}
    }
    await updateDoc(doc(db,'users',uid(),'batches',_editStuBid,'students',_editStuSid),upd);
    _invalidateBatchCache(_editStuBid);
    batchStudents[_editStuSid]={...batchStudents[_editStuSid],...upd};
    closeEditStudentModal(); renderBatchDetail(_editStuBid);
    toast('Student updated \u2713','success');
  }catch(e){toast('Failed: '+e.message,'error');}
  btn.disabled=false;btn.textContent='Save Changes';
}

window.openBatchDetail=async function(bid){
  if(!batches[bid]) return toast('Batch not found','error');
  screenTo('batchDetailScreen','appScreen','right');
  document.getElementById('bdTitle').textContent=batches[bid].name;
  document.getElementById('bdSub').textContent=batches[bid].subject||'';
  // Batch detail skeleton
  const skStudentCard = (op) => `
    <div class="sk-teacher-card" style="border-radius:20px;margin-bottom:10px;opacity:${op};">
      <div class="sk-row sk-mb8">
        <div class="sk sk-circle" style="width:32px;height:32px;flex-shrink:0;"></div>
        <div style="flex:1;padding-left:8px;">
          <div class="sk sk-mb4" style="width:48%;height:13px;"></div>
          <div class="sk" style="width:32%;height:9px;opacity:.5;"></div>
        </div>
        <div style="text-align:right;">
          <div class="sk sk-mb4" style="width:52px;height:22px;border-radius:8px;"></div>
          <div class="sk" style="width:38px;height:9px;opacity:.4;"></div>
        </div>
      </div>
      <div class="sk-tabs">${'<div class="sk sk-tab-item"></div>'.repeat(3)}</div>
    </div>`;
  document.getElementById('bdBody').innerHTML=`
    <div style="padding:0 4px;">
      <div class="sk sk-bd-summary" style="margin-bottom:16px;"></div>
      <div class="sk-section-row sk-mb12">
        <div class="sk" style="width:70px;height:11px;border-radius:6px;opacity:.5;"></div>
        <div class="sk sk-pill" style="width:28px;height:18px;opacity:.4;"></div>
      </div>
      ${skStudentCard(1)}${skStudentCard(.65)}${skStudentCard(.35)}
    </div>
  `;
  await loadBatchDetail(bid);};
window.closeBatchDetail=function(){
  screenTo('appScreen','batchDetailScreen','left');
  currentBatchId=null;batchStudents={};batchPayments=[];};

let pendingStudents=[]; // [{name,date,feeStatus,lastPaid}]
let newFeeStatus='never';
let editFeeStatus='never';

window.setNewFeeStatus=function(s){
  newFeeStatus=s;
  const nEl=document.getElementById('feeStatusNever'),dEl=document.getElementById('feeStatusDate'),wrap=document.getElementById('lastPaidDateWrap');
  nEl.style.border=s==='never'?'1.5px solid var(--accent3)':'1.5px solid var(--border)';
  nEl.style.background=s==='never'?'rgba(0,212,170,.1)':'var(--surface2)';
  dEl.style.border=s==='date'?'1.5px solid var(--accent)':'1.5px solid var(--border)';
  dEl.style.background=s==='date'?'rgba(124,107,255,.1)':'var(--surface2)';
  wrap.style.display=s==='date'?'block':'none';
};
window.setEditFeeStatus=function(s){
  editFeeStatus=s;
  const nEl=document.getElementById('editFeeStatusNever'),dEl=document.getElementById('editFeeStatusDate'),wrap=document.getElementById('editLastPaidDateWrap');
  nEl.style.border=s==='never'?'1.5px solid var(--accent3)':'1.5px solid var(--border)';
  nEl.style.background=s==='never'?'rgba(0,212,170,.1)':'var(--surface2)';
  dEl.style.border=s==='date'?'1.5px solid var(--accent)':'1.5px solid var(--border)';
  dEl.style.background=s==='date'?'rgba(124,107,255,.1)':'var(--surface2)';
  wrap.style.display=s==='date'?'block':'none';
};
function openAddStudentModal(){
  pendingStudents=[];renderPendingList();
  document.getElementById('newStudentNameInp').value='';
  document.getElementById('newStudentDateInp').value='';
  const pdi=document.getElementById('newStudentPayDateInp'); if(pdi) pdi.value='';
  const lpi=document.getElementById('newStudentLastPaidInp'); if(lpi) lpi.value='';
  newFeeStatus='never'; window.setNewFeeStatus('never');
  document.getElementById('addStudentModal').classList.remove('hidden');
  setTimeout(()=>document.getElementById('newStudentNameInp').focus(),200);
}
function closeAddStudentModal(){document.getElementById('addStudentModal').classList.add('hidden');}
function renderPendingList(){
  const co=document.getElementById('pendingStudentsList');
  if(!pendingStudents.length){co.innerHTML='<div style="font-size:12px;color:var(--muted);text-align:center;padding:14px 0;">Students you queue will appear here</div>';return;}
  const MONTHS_S=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  co.innerHTML=pendingStudents.map((s,i)=>{
    let dateLabel='';
    if(s.date){const p=s.date.split('-');dateLabel=`${parseInt(p[2])} ${MONTHS_S[parseInt(p[1])-1]} ${p[0]}`;}
    let feeLabel=s.feeStatus==='date'&&s.lastPaid?(()=>{const lp=s.lastPaid.split('-');return `Last paid: ${parseInt(lp[2])} ${MONTHS_S[parseInt(lp[1])-1]} ${lp[0]}`;})():'Never paid';
    return `<div class="slp-item">
      <div class="slp-info">
        <div class="slp-name">${s.name}</div>
        ${dateLabel?`<div class="slp-date">Joined: ${dateLabel}</div>`:'<div class="slp-date" style="font-style:italic;">No admission date</div>'}
        <div class="slp-date" style="color:${s.feeStatus==='date'?'var(--accent3)':'var(--red)'};">${feeLabel}</div>
      </div>
      <div class="slp-actions">
        <button class="slp-edit" onclick="editPending(${i})"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M8 2l2 2-6 6H2V8L8 2z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Edit</button>
        <button class="slp-rm" onclick="rmPending(${i})">&#x2715;</button>
      </div>
    </div>`;
  }).join('');
}
function addOnePending(){
  const ni=document.getElementById('newStudentNameInp'),v=ni.value.trim();
  const di=document.getElementById('newStudentDateInp'),d=di.value;
  const pdi=document.getElementById('newStudentPayDateInp'),pd=pdi?pdi.value:'';
  const lpi=document.getElementById('newStudentLastPaidInp'),lp=lpi?lpi.value:'';
  if(!v)return;
  if(newFeeStatus==='date'&&!lp)return toast('Enter last payment date','error');
  pendingStudents.push({name:v,date:d,payDate:pd,feeStatus:newFeeStatus,lastPaid:lp});
  ni.value='';di.value='';if(pdi)pdi.value='';if(lpi)lpi.value='';
  newFeeStatus='never';window.setNewFeeStatus('never');
  ni.focus();renderPendingList();
}
window.rmPending=function(i){pendingStudents.splice(i,1);renderPendingList();};

window.editPending=function(i){
  const s=pendingStudents[i];
  document.getElementById('newStudentNameInp').value=s.name;
  document.getElementById('newStudentDateInp').value=s.date||'';
  const pdi=document.getElementById('newStudentPayDateInp'); if(pdi) pdi.value=s.payDate||'';
  const lpi=document.getElementById('newStudentLastPaidInp'); if(lpi) lpi.value=s.lastPaid||'';
  if(s.feeStatus) window.setNewFeeStatus(s.feeStatus);
  pendingStudents.splice(i,1);renderPendingList();
  document.getElementById('newStudentNameInp').focus();
};
async function saveAllStudents(){
  if(!pendingStudents.length)return toast('Add at least one student','error');
  const btn=document.getElementById('saveStudentsBtn');btn.disabled=true;btn.textContent='Saving\u2026';
  const bid=currentBatchId,now=new Date(),bm=now.getMonth()+1,by=now.getFullYear();
  try{
    await Promise.all(pendingStudents.map(s=>{
      const sd={name:s.name,baselineMonth:bm,baselineYear:by,createdAt:Date.now(),feeStatus:s.feeStatus||'never'};
      if(s.date){const p=s.date.split('-');sd.admissionDay=parseInt(p[2]);sd.admissionMonth=parseInt(p[1]);sd.admissionYear=parseInt(p[0]);}
      if(s.payDate){
        
        const pp=s.payDate.split('-');
        sd.baselineMonth=parseInt(pp[1]);sd.baselineYear=parseInt(pp[0]);
        sd.lastPaidDate=s.payDate;
      } else if(s.feeStatus==='date'&&s.lastPaid){
        const lp=s.lastPaid.split('-');
        sd.baselineMonth=parseInt(lp[1]);sd.baselineYear=parseInt(lp[0]);
        sd.lastPaidDay=parseInt(lp[2]);sd.lastPaidMonth=parseInt(lp[1]);sd.lastPaidYear=parseInt(lp[0]);
      } else if(s.date){
        const p=s.date.split('-'),aMs=parseInt(p[0])*12+parseInt(p[1]),nMs=by*12+bm;
        if(aMs<nMs){sd.baselineMonth=parseInt(p[1]);sd.baselineYear=parseInt(p[0]);}
      }
      return addDoc(stuCol(bid),sd);
    }));
    _invalidateBatchCache(bid);
    closeAddStudentModal();toast(pendingStudents.length+' student'+(pendingStudents.length>1?'s':'')+' added \u2713','success');
    await loadBatchDetail(bid);
  }catch(e){toast('Error: '+e.message,'error');}
  btn.disabled=false;btn.textContent='Save All';}

function renderTeacher(){
  const root=document.getElementById('appInner');
  const subjs=profile.subjects||[], classes=profile.classes||[], sess=profile.session||'', bList=Object.keys(batches);
  const subjLine=[subjs.length?subjs.join(', '):'No subjects set', classes.length?classes.join(', '):'', sess].filter(Boolean).join(' · ');
  let h=`
    ${!profile.displayName?`<div class="setup-banner" onclick="openProfileModal()"><span class="setup-banner-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><circle cx="7" cy="5.5" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M1 15c0-3.3 2.7-5 6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 10v6M10 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><div class="setup-banner-text"><div class="setup-banner-title">Set up your teacher profile</div><div class="setup-banner-sub">Add your subjects and session</div></div><button class="setup-banner-btn">Set up</button></div>`:''}
    <div class="teacher-mode-header" onclick="openTeacherDash()" style="cursor:pointer" title="Open Analytics"><div class="tmh-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><circle cx="7" cy="5.5" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M1 15c0-3.3 2.7-5 6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 10v6M10 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div><div class="tmh-info"><div class="tmh-title">Teacher Dashboard</div><div class="tmh-sub">${subjLine}</div></div><div style="display:flex;align-items:center;color:var(--accent);opacity:.8;transition:opacity .2s;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <div class="search-wrap">
      <span class="search-icon" style="display:flex;align-items:center;"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="display:block"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.7"/><line x1="10.5" y1="10.5" x2="14.5" y2="14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>
      <input class="search-input" type="text" placeholder="Search batch…" id="teacherSearchInp" value="${searchQ}" oninput="onSearch(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}" />
      ${searchQ?`<span class="search-clear" onclick="onSearch('');const s=document.getElementById('teacherSearchInp');if(s){s.value='';s.focus();}" style="display:flex;align-items:center;justify-content:center;cursor:pointer;"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="display:block"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>`:''}
    </div>
    <div class="section-label"><span class="section-label-txt">My Batches</span><span class="section-label-count">${bList.length}</span></div>`;
  if(!bList.length && !_standaloneStudents.length){
    h+=`<div class="empty-state"><div class="empty-icon" style="display:flex;align-items:center;justify-content:center;margin-bottom:14px;"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M26 9L5 21l21 12 21-12L26 9z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 30l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/><path d="M5 39l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/></svg></div><div class="empty-title">No batches yet</div><div class="empty-sub">Tap <strong>+</strong> to create a batch and start tracking fees.</div></div>`;
    root.innerHTML=h; return;
  }
  if(bList.length){
    const fil=bList.filter(id=>{const q=searchQ.toLowerCase();return !q||batches[id].name.toLowerCase().includes(q)||batches[id].subject?.toLowerCase().includes(q);}).sort((a,b)=>{
      return 0;
    });
    let dl=0;
    for(const bid of fil){const b=batches[bid];
      const isSel=selMode&&selContext==='batch'&&selItems.has(bid);
      h+=`<div class="batch-card ${isSel?'selected':''}" data-id="${bid}" style="animation-delay:${dl}s"
        onclick="if(selMode&&selContext==='batch'){selTap('${bid}');return;}openBatchDetail('${bid}')">

        <div class="batch-header"><div><div class="batch-name">${b.name}</div><div class="batch-meta">${b.class?b.class+' · ':''} ${fmt(b.fee)}/mo per student${b.timing?' · '+b.timing:''}</div></div>${b.session?`<span class="batch-session-badge">${b.session}</span>`:''}</div>
        <div class="batch-subject-list">${b.subject.split(',').map(s=>`<span class="batch-subj-chip">${s.trim()}</span>`).join('')}</div>
        ${selMode&&selContext==='batch'?'':`<div class="batch-actions">
          <button class="batch-open-btn" onclick="event.stopPropagation();openBatchDetail('${bid}')" style="display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0" ><path d="M11 13v-1a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M14 13v-1a3 3 0 0 0-2-2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> View students ›</button>
          <button class="batch-del-btn" onclick="event.stopPropagation();deleteBatch('${bid}')" style="display:flex;align-items:center;justify-content:center;"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:block"><path d="M2 4h12M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>`}
      </div>`;dl=Math.min(dl+0.05,0.3);}
  }
  root.innerHTML=h;
  _renderStandaloneSection();
}

let _standaloneStudents=[], _assignIsStandalone=false;

async function loadStandaloneStudents(){
  // ── TTL gate — skip Firestore read if standalone list is fresh ──
  try {
    const ssTs = await idbGet('_standaloneStudentsTs');
    if (ssTs && (Date.now() - ssTs) < 5 * 60 * 1000) {
      const cached = await idbGet('standalone_students');
      if (cached) { _standaloneStudents = cached; return; }
    }
  } catch(e) { /* proceed */ }
  try{
    const snap=await getDocs(collection(db,'users',uid(),'students'));
    _standaloneStudents=[];
    snap.forEach(d=>_standaloneStudents.push({id:d.id,...d.data()}));
    // Cache for offline use
    idbSet('standalone_students', _standaloneStudents);
    try { idbSet('_standaloneStudentsTs', Date.now()); } catch(e){}
  }catch(e){
    // Offline — use cached data if available
    const cached = await idbGet('standalone_students');
    if(cached) _standaloneStudents=cached;
    else _standaloneStudents=[];
  }
}

function _renderStandaloneSection(){
  document.getElementById('standaloneSection')?.remove();
  if(!_standaloneStudents.length) return;
  const appInner=document.getElementById('appInner'); if(!appInner) return;
  const now=new Date(),curM=now.getMonth()+1,curY=now.getFullYear();
  const sec=document.createElement('div'); sec.id='standaloneSection'; sec.style.marginTop='18px';
  let h=`<div class="section-label standalone-section-lbl"><span class="section-label-txt">Individual Students</span><span class="section-label-count">${_standaloneStudents.length}</span></div>`;
  [..._standaloneStudents].sort((a,b)=>(a.name||'').localeCompare(b.name||'')).forEach((s,i)=>{
    const fee=s.fee||0,bm=s.baselineMonth||curM,by=s.baselineYear||curY;
    const mo=Math.max(mBetween({month:bm,year:by},{month:curM,year:curY}),0);
    const due=Math.max(mo*fee,0);
    const isSel=selMode&&selContext==='standalone'&&selItems.has(s.id);
    const dueCol=due===0?'var(--accent3)':mo>=6?'var(--red)':mo>=3?'var(--yellow)':'var(--accent4)';
    h+=`<div class="standalone-card ${isSel?'selected':''} ${selMode&&selContext==='standalone'?'sel-mode':''}" data-id="${s.id}" data-ctx="standalone" style="animation-delay:${i*0.04}s"
      onclick="if(selMode&&selContext==='standalone'){event.stopPropagation();selTap('${s.id}');return;}">
      
      <div class="standalone-top">
        <div class="standalone-avatar">${(s.name||'S')[0].toUpperCase()}</div>
        <div class="standalone-info">
          <div class="standalone-name">${s.name||'Student'}</div>
          <div class="standalone-meta">Individual · ${fmt(fee)}/mo</div>
          ${s.lastPaidDate?`<div style="font-size:10px;color:var(--accent3);margin-top:2px">Last paid: ${s.lastPaidDate}</div>`:'<div style="font-size:10px;color:var(--red);opacity:.7;margin-top:2px">Never paid</div>'}
        </div>
        <div class="standalone-due">
          <div class="standalone-due-amt" style="color:${dueCol}">${fmt(due)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">${mo===0?'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Clear':mo+'mo due'}</div>
        </div>
      </div>
      ${selMode&&selContext==='standalone'?'':`<div class="standalone-actions">
        <button class="standalone-action-btn" onclick="event.stopPropagation();openEditStandaloneStudent('${s.id}')" style="color:var(--accent)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:block;flex-shrink:0"><path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit
        </button>
        <button class="standalone-action-btn" onclick="event.stopPropagation();promptAssignStandalone('${s.id}','${(s.name||'').replace(/'/g,"\'")}')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:block;flex-shrink:0"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="7.5" x2="11" y2="7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="5" x2="8" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Add to Batch
        </button>
        <button class="standalone-action-btn del" onclick="event.stopPropagation();deleteStandaloneStudent('${s.id}','${(s.name||'').replace(/'/g,"\'")}')" style="color:var(--red)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:block;flex-shrink:0"><path d="M2.5 4.5h11M6.5 2.5h3M5.5 4.5l.5 9M10.5 4.5l-.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Delete
        </button>
      </div>`}
    </div>`;
  });
  sec.innerHTML=h;
  appInner.appendChild(sec);
}

window.openEditStandaloneStudent=function(sid){
  const s=_standaloneStudents.find(x=>x.id===sid); if(!s) return;
  _editSsId=sid;
  document.getElementById('editSsNameInp').value=s.name||'';
  document.getElementById('editSsFeeInp').value=s.fee||'';
  document.getElementById('editSsPayDateInp').value=s.lastPaidDate||'';
  document.getElementById('editSsDateInp').value=s.admissionYear?`${s.admissionYear}-${String(s.admissionMonth||1).padStart(2,'0')}-${String(s.admissionDay||1).padStart(2,'0')}`:'';
  document.getElementById('editStandaloneStudentModal').classList.remove('hidden');
};
window.promptAssignStandalone=function(sid,name){
  _assignStudentIds=[sid]; _assignIsStandalone=true;
  const list=document.getElementById('assignBatchList');
  let ah='';
  Object.keys(batches).forEach(bid=>{const b=batches[bid];ah+=`<div class="batch-pick-item" data-bid="${bid}" onclick="toggleBatchPick(this,'${bid}')"><div class="batch-pick-icon" style="display:flex;align-items:center;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M1 5a2 2 0 0 1 2-2h3.5l1.5 2H13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity=".08"/></svg></div><div><div class="batch-pick-name">${b.name}</div><div class="batch-pick-sub">${fmt(b.fee)}/mo per student</div></div></div>`;});
  ah+=`<div class="batch-pick-item" onclick="toggleBatchPick(this,'__new__')" style="border-style:dashed"><div style="font-size:18px;font-weight:700">+</div><div><div class="batch-pick-name">Create New Batch</div><div class="batch-pick-sub">Move to a brand new batch</div></div></div>`;
  list.innerHTML=ah||'<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No batches. Use + to create one first.</div>';
  document.getElementById('assignBatchModal').classList.remove('hidden');
};
window.deleteStandaloneStudent=async function(sid,name){
  if(!await confirm2('Remove Student',`Remove <strong style="color:#f0f0f8">${name}</strong>?`,'Remove',_CI.rem)) return;
  try{
    await deleteDoc(doc(db,'users',uid(),'students',sid));
    _standaloneStudents=_standaloneStudents.filter(s=>s.id!==sid);
    toast(`${name} removed`,'');
    _renderStandaloneSection();
  }catch(e){toast('Error: '+e.message,'error');}
};
// ONBOARDING -- 3-step with smart button visibility
let obRole = '', obSubjects = [], obClasses = [];

function obShowBtn(id){
  // Hide all step buttons first
  ['obNextBtn1','obNextBtn2','obDoneBtn','obDoneTeacherBtn'].forEach(b=>{
    const el=document.getElementById(b); if(el) el.style.display='none';
  });
  const el=document.getElementById(id); if(el) el.style.display='';
}

window.obSelectRole = function(r){
  obRole=r;
  document.getElementById('obRoleS').className='ob-role-card'+(r==='student'?' sel-s':'');
  document.getElementById('obRoleT').className='ob-role-card'+(r==='teacher'?' sel-t':'');
  const cs=document.getElementById('obCheckS'), ct=document.getElementById('obCheckT');
  const SVG_CHECK='<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><polyline points="1.5,5 4,8 8.5,2" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if(cs) cs.innerHTML=r==='student'?SVG_CHECK:'';
  if(ct) ct.innerHTML=r==='teacher'?SVG_CHECK:'';
  // Show Next only after role is picked
  obShowBtn('obNextBtn1');
};

function obAnimateStep(el){
  if(!el) return;
  el.classList.remove('ob-step-enter');
  void el.offsetWidth;
  el.classList.add('ob-step-enter');
  el.addEventListener('animationend',()=>el.classList.remove('ob-step-enter'),{once:true});
}
window.obNext = function(from){
  if(from===1){
    if(!obRole){ toast('Please select Student or Teacher','error'); return; }
    document.getElementById('obStep1').classList.add('hidden');
    const s2=document.getElementById('obStep2');
    s2.classList.remove('hidden');
    obAnimateStep(s2);
    // Show Next immediately if name already pre-filled, else hide
    const preN=document.getElementById('obName').value.trim();
    obShowBtn(preN?'obNextBtn2':'__none__');
    setTimeout(()=>document.getElementById('obName')?.focus(), 100);
  } else if(from===2){
    const name=document.getElementById('obName').value.trim();
    if(!name){ toast('Please enter your name','error'); return; }
    document.getElementById('obStep2').classList.add('hidden');
    if(obRole==='student'){
      const sf=document.getElementById('obStudentFields');
      sf.classList.remove('hidden');
      obAnimateStep(sf);
    } else {
      const tf=document.getElementById('obTeacherFields');
      tf.classList.remove('hidden');
      obAnimateStep(tf);
    }
    // Hide done btn until fields are filled
    obShowBtn('__none__');
  }
};

// Name input: show Next when non-empty
document.getElementById('obName')?.addEventListener('input',()=>{
  const v=document.getElementById('obName').value.trim();
  const btn=document.getElementById('obNextBtn2');
  if(btn && !document.getElementById('obStep2').classList.contains('hidden'))
    btn.style.display=v?'':'none';
});
document.getElementById('obName')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'){ e.preventDefault(); window.obNext(2); }
});

window.obChip = function(el){
  document.querySelectorAll('.ob-chip').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById('obClass').value=el.dataset.val;
  obShowBtn('obDoneBtn');
};

// Class free-text: show done when non-empty
document.getElementById('obClass')?.addEventListener('input',()=>{
  const v=document.getElementById('obClass').value.trim();
  document.querySelectorAll('.ob-chip').forEach(c=>c.classList.toggle('sel',c.dataset.val===v));
  const btn=document.getElementById('obDoneBtn');
  if(btn) btn.style.display=v?'':'none';
});

window.obAddSubj = function(){
  const inp=document.getElementById('obSubjInp'), v=inp.value.trim();
  if(!v) return;
  if(!obSubjects.includes(v)) obSubjects.push(v);
  inp.value=''; inp.focus(); obRenderSubjs();
  // Show done btn when at least 1 subject added
  if(obSubjects.length>0) obShowBtn('obDoneTeacherBtn');
};
function obRenderSubjs(){
  const el=document.getElementById('obSubjTags'); if(!el) return;
  el.innerHTML=obSubjects.map((s,i)=>
    '<div class="ob-subj-tag">'+s+'<button class="ob-subj-rm" onclick="obRmSubj('+i+')">&#215;</button></div>'
  ).join('');
}
window.obRmSubj=function(i){
  obSubjects.splice(i,1); obRenderSubjs();
  if(obSubjects.length===0) obShowBtn('__none__');
};

window.obAddClass = function(){
  const inp=document.getElementById('obClassInp'), v=inp.value.trim();
  if(!v) return;
  if(!obClasses.includes(v)) obClasses.push(v);
  inp.value=''; inp.focus(); obRenderClasses();
};
function obRenderClasses(){
  const el=document.getElementById('obClassTags'); if(!el) return;
  el.innerHTML=obClasses.map((c,i)=>
    '<div class="ob-subj-tag" style="background:rgba(0,212,170,.12);border-color:rgba(0,212,170,.25);color:var(--accent3);">'+c+'<button class="ob-subj-rm" onclick="obRmClass('+i+')">&#215;</button></div>'
  ).join('');
  document.querySelectorAll('#obTeacherFields .ob-chip[data-val]').forEach(ch=>{
    ch.classList.toggle('sel', obClasses.includes(ch.dataset.val));
  });
}
window.obRmClass=function(i){ obClasses.splice(i,1); obRenderClasses(); };
window.obToggleClassChip=function(el){
  const v=el.dataset.val;
  if(obClasses.includes(v)) obClasses=obClasses.filter(c=>c!==v);
  else obClasses.push(v);
  obRenderClasses();
};

document.getElementById('obSubjInp')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();window.obAddSubj();}
});

async function obSubmit(){
  const name=document.getElementById('obName').value.trim();
  if(!name){ toast('Enter your name first','error'); return; }
  if(!obRole){ toast('Select a role first','error'); return; }
  const btnId=obRole==='student'?'obDoneBtn':'obDoneTeacherBtn';
  const btn=document.getElementById(btnId);
  if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
  const d={role:obRole,displayName:name,updatedAt:Date.now()};
  if(obRole==='student'){
    d.className=document.getElementById('obClass').value.trim();
  } else {
    if(!obSubjects.length){ if(btn){btn.disabled=false;btn.textContent='Get Started →';} return toast('Add at least one subject','error'); }
    d.subjects=[...obSubjects];
    d.classes=[...obClasses];
    d.session=document.getElementById('obSession').value.trim();
  }
  try{
    await setDoc(prRef(),d);
    profile=d; saveProfileToCache(d); updateRole();
    document.getElementById('onboardScreen').classList.add('hidden');
    hideSplash();
    document.getElementById('appScreen').classList.remove('hidden');
    await loadAll();
    toast('Welcome, '+name.split(' ')[0]+'!','success');
  } catch(e){ toast('Save failed: '+e.message,'error'); }
  if(btn){ btn.disabled=false; btn.textContent='Get Started →'; }
}

// AUTH
let loaded = false;

function hideSplash(){
  if (typeof _skelKill !== 'undefined') try { clearTimeout(_skelKill); } catch {}
  const s=document.getElementById('splashSkeleton');
  if(s){ s.classList.add('fade-out'); setTimeout(()=>{ if(s.parentNode) s.parentNode.removeChild(s); },400); }
}

async function bootApp(user) {
  if (loaded) return;
  _reconnecting  = false;
  _offlineBooted = false;
  showOfflineBanner(false);
  loaded = true; cu = user;

  // Hard deadline — skeleton must be gone within 4s regardless of what
  // happens below (slow Firestore, IDB block, any exception).
  const _skelKill = setTimeout(hideSplash, 4000);

  db = _db1;
  try { localStorage.setItem('ft_uid', user.uid); } catch {}

  const _gb = document.getElementById('googleSignInBtn');
  if (_gb) _gb.disabled = false;

  // ── Update avatar / menu immediately ──
  const av = document.getElementById('avatarEl');
  const ma = document.getElementById('menuAvatar');
  const initial = (user.displayName||'U')[0].toUpperCase();
  if (user.photoURL) {
    av.innerHTML=`<img src="${user.photoURL}">`;
    ma.innerHTML=`<img src="${user.photoURL}">`;
  } else { av.textContent=initial; ma.textContent=initial; }
  document.getElementById('menuName').textContent  = user.displayName||'User';
  document.getElementById('menuEmail').textContent = user.email||'';
  document.getElementById('loginScreen').classList.add('hidden');
  window._syncSidebarUser?.(user);
  sbSetPage?.('home');
  const splashAv = document.getElementById('splashAvatar');
  if (splashAv) {
    splashAv.classList.remove('sk');
    splashAv.style.background = 'linear-gradient(135deg, var(--accent), #5a4de6)';
    if (user.photoURL) splashAv.innerHTML=`<img src="${user.photoURL}" style="width:100%;height:100%;object-fit:cover;">`;
    else splashAv.textContent = initial;
  }

  // ── Step 1: Load IDB cache (fast, local storage) ──
  await loadFromCacheAsync();

  if (profile.role) {
    // ── Cached profile found — show app INSTANTLY, sync Firestore in background ──
    hideSplash();
    document.getElementById('appScreen').classList.remove('hidden');
    render(); // immediate render from cache
    appRendered = true;

    // Background refresh — doesn't block UI
    Promise.resolve().then(async () => {
      await loadProfile();
      updateRole();
      await loadAll(false);
      _refreshConnectNotif().catch(()=>{});
      setTimeout(() => {
        initNotifications();
        showNotifPrompt();
        refreshFCMTokenIfNeeded();
      }, 1500);
    }).catch(() => {});

  } else {
    // ── No cached profile — first login or cleared cache, must wait ──
    const _alo = document.getElementById('authOverlay');
    if (_alo) _alo.classList.add('show');
    await loadProfile();
    if (_alo) _alo.classList.remove('show');

    if (!profile.role) {
      hideSplash();
      document.getElementById('obName').value = user.displayName||'';
      document.getElementById('onboardScreen').classList.remove('hidden');
      sbSetPage?.('onboard');
      window._sbRefreshLayout?.();
    } else {
      hideSplash();
      document.getElementById('appScreen').classList.remove('hidden');
      try { await loadAll(false); } catch {}
      _refreshConnectNotif().catch(()=>{});
      setTimeout(() => {
        initNotifications();
        showNotifPrompt();
        refreshFCMTokenIfNeeded();
      }, 1500);
    }
  }
}

// ── Auth error helpers ─────────────────────────────────────────────────────
const _GOOGLE_BTN_HTML =
  '<svg class="google-icon" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Continue with Google';

function _authErrMsg(code) {
  const m = {
    'auth/unauthorized-domain':
      `This domain is not authorised in Firebase.\n` +
      `Go to Firebase Console → Authentication → Settings → Authorized domains\n` +
      `and add: ${location.hostname}`,
    'auth/operation-not-allowed':
      'Google sign-in is not enabled.\n' +
      'Go to Firebase Console → Authentication → Sign-in method → Google → Enable.',
    'auth/invalid-api-key':
      'Invalid Firebase API key. Check the FB1_API_KEY secret in Cloudflare Pages.',
    'auth/network-request-failed':
      'Network error — check your connection and try again.',
    'auth/too-many-requests':
      'Too many sign-in attempts. Wait a minute and try again.',
    'auth/internal-error':
      'Firebase internal error. Open DevTools (F12) → Console for details.',
    'auth/popup-blocked':
      'Popup blocked — switching to redirect sign-in…',
    'auth/cancelled-popup-request':
      null, // user opened sign-in again; silent
    'auth/popup-closed-by-user':
      null, // user closed popup; silent
    'auth/user-cancelled':
      null, // user dismissed; silent
  };
  return m[code] !== undefined ? m[code] : `Sign-in failed (${code || 'unknown'})`;
}

function _showAuthError(msg) {
  if (!msg) return;
  let el = document.getElementById('_authErrEl');
  if (!el) {
    el = document.createElement('div');
    el.id = '_authErrEl';
    el.style.cssText =
      'margin-top:12px;padding:12px 14px;border-radius:12px;font-size:12px;line-height:1.55;' +
      'color:var(--red,#ff4d6d);background:rgba(255,77,109,.08);border:1px solid rgba(255,77,109,.22);' +
      'white-space:pre-wrap;word-break:break-word;text-align:left;';
    const btn = document.getElementById('googleSignInBtn');
    btn?.parentNode?.insertBefore(el, btn.nextSibling);
  }
  el.textContent = msg;
  el.style.display = '';
}

function _clearAuthError() {
  const el = document.getElementById('_authErrEl');
  if (el) el.style.display = 'none';
}

function _resetSignInBtn() {
  const btn = document.getElementById('googleSignInBtn');
  if (btn) { btn.innerHTML = _GOOGLE_BTN_HTML; btn.disabled = false; }
  document.getElementById('avatarEl')?.classList.remove('loading');
}

setPersistence(auth, browserLocalPersistence).catch(()=>{});

// Handle redirect-based sign-in returning to the page
getRedirectResult(auth).then(async r => {
  if (r?.user) { _clearAuthError(); await bootApp(r.user); }
}).catch(e => {
  const skip = ['auth/no-current-user', 'auth/null-user'];
  if (!e.code || skip.includes(e.code)) return;
  const msg = _authErrMsg(e.code);
  if (msg) { _showAuthError(msg); _resetSignInBtn(); }
});

// Snapshot uid synchronously BEFORE any Firebase async code runs.
// onAuthStateChanged(null) fires when offline and wipes ft_uid —
// this snapshot preserves it so the offline guard always works.
const _cachedUidSnapshot = localStorage.getItem('ft_uid');
let _offlineBooted = false;
let _reconnecting  = false; // blocks false signout during reconnect window
let _onlineSince   = 0;

// ── Shared cache-boot helper ───────────────────────────────────────────
async function _bootFromCache(cachedUid, cachedProfile) {
  if (_offlineBooted || loaded) return;
  _offlineBooted = true;
  db = _db1;
  const fakeUser = { uid: cachedUid, displayName: cachedProfile.displayName || 'User', photoURL: null, email: cachedProfile.email || '' };
  await loadFromCacheAsync();
  profile = cachedProfile; updateRole();
  const av = document.getElementById('avatarEl');
  const ma = document.getElementById('menuAvatar');
  const initial = (fakeUser.displayName||'U')[0].toUpperCase();
  if (av) { av.textContent = initial; av.classList.remove('loading'); }
  if (ma) ma.textContent = initial;
  document.getElementById('menuName').textContent  = fakeUser.displayName;
  document.getElementById('menuEmail').textContent = '(offline)';
  document.getElementById('loginScreen')?.classList.add('hidden');
  document.getElementById('onboardScreen')?.classList.add('hidden');
  const hasCachedData = isT() ? Object.keys(batches).length > 0 : Object.keys(teachers).length > 0;
  if (hasCachedData) render();
  hideSplash();
  document.getElementById('appScreen').classList.remove('hidden');
  // Only show offline banner if actually offline
  if (!navigator.onLine) showOfflineBanner(true);
}

// ── Offline boot — 600ms ──────────────────────────────────────────────
// Fires only when offline. One timer is enough — 150ms is too fast for
// IDB to respond, and 1400ms is needlessly slow. 600ms hits after IDB
// resolves but before the user notices anything is wrong.
setTimeout(async () => {
  if (navigator.onLine) return;
  if (loaded || _offlineBooted) return;
  if (!_cachedUidSnapshot) return;
  const cachedProfile = await idbGet('profile').catch(() => null) || LS.get('profile');
  if (cachedProfile && cachedProfile.role) {
    await _bootFromCache(_cachedUidSnapshot, cachedProfile);
  } else {
    // Offline, no cached profile — show "waiting for connection" shell
    _offlineBooted = true;
    hideSplash();
    document.getElementById('loginScreen')?.classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    showOfflineBanner(true);
    const root = document.getElementById('appInner');
    if (root) root.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;padding:40px 24px;text-align:center;gap:16px;"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="var(--border2)" stroke-width="2"/><path d="M24 14v10l6 4" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><div style="font-family:'Syne',sans-serif;font-size:17px;font-weight:800;color:var(--text);">Waiting for connection…</div><div style="font-size:13px;color:var(--muted);line-height:1.6;">Connect to the internet to load your data.</div></div>`;
  }
}, 600);

// ── Last-resort: redirect genuinely unauthenticated users ──────────────
// Only fires when there is NO cached UID at all — meaning the user was
// never signed in on this device. If _cachedUidSnapshot exists, Firebase
// Auth is still resolving (or offline) — do not redirect or we get a loop.
setTimeout(() => {
  if (loaded || _offlineBooted) return;
  if (_cachedUidSnapshot) return;          // has cached UID — wait, never redirect
  if (auth.currentUser) return;            // auth resolved — bootApp is running
  location.replace('./sign.html');
}, 6000);

// ── onAuthStateChanged ─────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    if (!loaded) await bootApp(user);
  } else {
    // ── REDIRECT LOOP FIX ─────────────────────────────────────────────
    // Firebase ALWAYS emits null synchronously on initialisation before it
    // has finished reading the persisted token from IndexedDB.  If we act
    // on that first null we clear ft_uid, redirect to sign.html, sign.html
    // sees the still-valid Firebase session → redirects back → loop.
    // Rule: if the app hasn't booted yet AND we have a cached UID, this is
    // the "pre-load" null — wait for the real resolved state.
    if (!loaded && _cachedUidSnapshot) return;

    // Firebase fires null when offline, or transiently during reconnect —
    // ignore unless it's a genuine sign-out (online, not reconnecting, not
    // mid offline-boot).
    if (_cachedUidSnapshot && (!navigator.onLine || _offlineBooted || _reconnecting)) return;
    // Real sign-out — clear cache and go to sign-in page
    cu=null; loaded=false; profile={}; appRendered=false; teachers={}; payments=[]; batches={};
    _offlineBooted = false; _reconnecting = false;
    try { localStorage.removeItem('ft_uid'); localStorage.setItem('ft_signed_out','1'); } catch(e){}
    try { idbSet('profile',null); idbSet('teachers',null); idbSet('payments',null); idbSet('batches',null);
          idbSet('_lastSyncTs',null); idbSet('_profileSyncTs',null); } catch(e){}
    window.location.replace('./sign.html');
  }
});

document.getElementById('googleSignInBtn').addEventListener('click', async () => {
  const btn = document.getElementById('googleSignInBtn');
  btn.innerHTML = '<span class="btn-spinner"><span class="spinner-ring spinner-sm"></span>Signing in\u2026</span>';
  btn.disabled = true;
  document.getElementById('avatarEl')?.classList.add('loading');
  _clearAuthError();

  // Mobile browsers block popups reliably — go straight to redirect
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  async function tryRedirect(errFromPopup) {
    // Show a transient toast for popup-blocked so the user knows what's happening
    if (errFromPopup?.code === 'auth/popup-blocked') toast('Popup blocked — redirecting\u2026');
    try {
      await signInWithRedirect(auth, provider);
      // page navigates away; getRedirectResult handles the result on return
    } catch(re) {
      const msg = _authErrMsg(re.code);
      if (msg) _showAuthError(msg); else toast('Sign-in error: '+re.code,'error');
      _resetSignInBtn();
    }
  }

  if (isMobile) { await tryRedirect(); return; }

  try {
    await signInWithPopup(auth, provider);
    // Success → onAuthStateChanged fires → bootApp handles it
    _clearAuthError();
  } catch(e) {
    const popupDismissed = ['auth/popup-closed-by-user','auth/cancelled-popup-request','auth/user-cancelled'];
    const popupBlocked   = ['auth/popup-blocked'];

    if (popupBlocked.includes(e.code)) {
      await tryRedirect(e);
    } else if (popupDismissed.includes(e.code)) {
      // User closed or cancelled — silently reset
      _resetSignInBtn();
    } else {
      const msg = _authErrMsg(e.code);
      if (msg) _showAuthError(msg); else toast('Sign-in failed: '+e.code,'error');
      _resetSignInBtn();
    }
  }
});

document.getElementById('avatarEl').addEventListener('click',toggleMenu);
document.getElementById('menuBackdrop').addEventListener('click',closeMenu);
document.getElementById('userMenu').addEventListener('click',e=>e.stopPropagation());
window.doSignOut=async function(){
  try{
    _reconnecting = false;
    window._clearSWCache?.();
    await signOut(auth);
  }catch(e){ toast('Sign out failed: '+e.message,'error'); }
};
document.getElementById('signOutBtn').addEventListener('click', async () => {
  closeMenu();
  try{
    _reconnecting = false;
    window._clearSWCache?.();
    await signOut(auth);
  }catch(e){ toast('Sign out failed: '+e.message,'error'); }
});
document.getElementById('editProfileBtn').addEventListener('click',()=>openProfileModal());
document.getElementById('addBtn').addEventListener('click',openAddModal);
document.getElementById('cancelAddBtn').addEventListener('click',closeAddModal);
document.getElementById('confirmAddBtn').addEventListener('click',confirmAdd);
document.getElementById('addModal').addEventListener('click',e=>{ if(e.target===document.getElementById('addModal')) closeAddModal(); });
document.getElementById('addStudentModal')?.addEventListener('click',e=>{ if(e.target===document.getElementById('addStudentModal')){ document.getElementById('addStudentModal').classList.add('hidden'); } });
document.getElementById('editStudentModal')?.addEventListener('click',e=>{ if(e.target===document.getElementById('editStudentModal')){ document.getElementById('editStudentModal').classList.add('hidden'); } });
document.getElementById('closeProfileBtn').addEventListener('click',closeProfileModal);
document.getElementById('saveProfileBtn').addEventListener('click',saveProfile);
document.getElementById('profileModal').addEventListener('click',e=>{ if(e.target===document.getElementById('profileModal')) closeProfileModal(); });
document.getElementById('subjectTagInput').addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();window.addSubjectTag();} });
document.getElementById('classTagInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();window.addClassTag();} });
document.getElementById('obClassInp')?.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();window.obAddClass();} });

// Add-student modal event wiring
document.getElementById('bdAddStudentBtn')?.addEventListener('click', openAddStudentModal);
document.getElementById('addOneStudentBtn')?.addEventListener('click', addOnePending);
document.getElementById('newStudentNameInp')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){e.preventDefault();addOnePending();} });
document.getElementById('saveStudentsBtn')?.addEventListener('click', saveAllStudents);
document.getElementById('cancelAddStudentBtn')?.addEventListener('click', closeAddStudentModal);
document.getElementById('closeAddStudentBtn')?.addEventListener('click', closeAddStudentModal);
document.getElementById('addStudentModal')?.addEventListener('click', e=>{ if(e.target===document.getElementById('addStudentModal')) closeAddStudentModal(); });

// Edit student modal
document.getElementById('closeEditStudentBtn')?.addEventListener('click', closeEditStudentModal);
document.getElementById('cancelEditStudentBtn')?.addEventListener('click', closeEditStudentModal);
document.getElementById('saveEditStudentBtn')?.addEventListener('click', saveEditStudent);
document.getElementById('editStudentModal')?.addEventListener('click', e=>{ if(e.target===document.getElementById('editStudentModal')) closeEditStudentModal(); });
document.getElementById('editStudentNameInp')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){e.preventDefault();saveEditStudent();} });
window.obSubmit = obSubmit;
window.openProfileModal=openProfileModal;
// Expose helpers for inline onclick handlers
window.isT = isT;
window.closeMenu = closeMenu;
window.openAddBatchModal = openAddBatchModal;
window.openAddModal = openAddModal;

// ═══════════════════════════════════════════════════
//  DRAG-TO-DISMISS — works on every .modal-handle
// ═══════════════════════════════════════════════════
(function initDragDismiss(){
  // Map overlay id → close function
  const MODAL_CLOSE = {
    profileModal:            () => closeProfileModal(),
    addModal:                () => closeAddModal(),
    addStudentModal:         () => closeAddStudentModal(),
    editStudentModal:        () => closeEditStudentModal(),
    editStandaloneStudentModal: () => document.getElementById('editStandaloneStudentModal')?.classList.add('hidden'),
    editTeacherModal:        () => closeEditTeacherModal?.(),
    teacherAddChoiceSheet:   () => document.getElementById('teacherAddChoiceSheet')?.classList.add('hidden'),
    assignBatchModal:        () => document.getElementById('assignBatchModal')?.classList.add('hidden'),
    addStandaloneStudentModal: () => document.getElementById('addStandaloneStudentModal')?.classList.add('hidden'),
    teacherDetailSheet:      () => closeTeacherDetail(),
  };

  // Dismiss a modal with a fly-down animation then hide it
  function dismissModal(overlay, sheet, closeFn){
    sheet.style.transition = 'transform .32s cubic-bezier(.4,0,.6,1), opacity .28s ease';
    sheet.style.transform  = `translateY(${sheet.offsetHeight + 20}px)`;
    sheet.style.opacity    = '0';
    overlay.style.transition = 'opacity .28s ease';
    overlay.style.opacity    = '0';
    setTimeout(() => {
      sheet.style.transform  = '';
      sheet.style.opacity    = '';
      overlay.style.opacity  = '';
      sheet.style.transition = '';
      overlay.style.transition = '';
      sheet.classList.remove('dragging');
      closeFn();
    }, 300);
  }

  document.querySelectorAll('.modal-handle').forEach(handle => {
    let startY = 0, curY = 0, dragging = false;
    const overlay = handle.closest('.modal-overlay');
    const sheet   = handle.closest('.modal-sheet');
    if (!overlay || !sheet) return;

    const overlayId = overlay.id;
    const closeFn   = MODAL_CLOSE[overlayId] || (() => overlay.classList.add('hidden'));

    function onStart(e){
      startY  = e.touches ? e.touches[0].clientY : e.clientY;
      curY    = 0;
      dragging = true;
      handle.classList.add('dragging');
      sheet.classList.add('dragging');
      sheet.style.transition = 'none';
    }

    function onMove(e){
      if (!dragging) return;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - startY;
      if (y < 0) return; // no pulling upward
      curY = y;
      sheet.style.transform = `translateY(${y}px)`;
      // Dim the backdrop as it's dragged down
      const pct = Math.min(y / (sheet.offsetHeight * 0.55), 1);
      overlay.style.background = `rgba(0,0,0,${0.75 * (1 - pct * 0.7)})`;
      if (e.cancelable) e.preventDefault();
    }

    function onEnd(){
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      const threshold = sheet.offsetHeight * 0.35; // 35% of sheet height
      if (curY > threshold) {
        dismissModal(overlay, sheet, closeFn);
      } else {
        // Snap back with spring
        sheet.style.transition  = 'transform .35s cubic-bezier(.34,1.35,.64,1)';
        sheet.style.transform   = 'translateY(0)';
        overlay.style.transition = 'background .25s';
        overlay.style.background = '';
        setTimeout(() => {
          sheet.style.transition  = '';
          sheet.classList.remove('dragging');
        }, 360);
      }
    }

    handle.addEventListener('touchstart', onStart, { passive: true });
    handle.addEventListener('touchmove',  onMove,  { passive: false });
    handle.addEventListener('touchend',   onEnd,   { passive: true });
    // Mouse support for desktop
    handle.addEventListener('mousedown', e => {
      onStart(e);
      const mm = ev => onMove(ev);
      const mu = ()  => { onEnd(); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup',   mu);
    });
  });
})();

// ── NOTIFICATION BANNER + MENU ──
document.getElementById('notifBannerAllow')?.addEventListener('click', async () => {
  document.getElementById('notifBanner').style.transform = 'translateY(100%)';
  localStorage.setItem('ft_notif_dismissed', '1');
  await initNotifications();
  updateNotifMenuLabel();
});
document.getElementById('notifBannerDismiss')?.addEventListener('click', () => {
  document.getElementById('notifBanner').style.transform = 'translateY(100%)';
  localStorage.setItem('ft_notif_dismissed', '1');
});
document.getElementById('notifBannerClose')?.addEventListener('click', () => {
  document.getElementById('notifBanner').style.transform = 'translateY(100%)';
  localStorage.setItem('ft_notif_dismissed', '1');
});
document.getElementById('menuNotifBtn')?.addEventListener('click', async () => {
  closeMenu();
  if (Notification.permission === 'granted') {
    // Already on — toggle off by clearing token
    await removeFCMToken();
    localStorage.removeItem('ft_fcm_token');
    localStorage.removeItem('ft_last_reminder');
    localStorage.removeItem('ft_notif_dismissed');
    toast('Reminders turned off', '');
    updateNotifMenuLabel();
  } else {
    await initNotifications();
  }
});

function _applyMenuToggle(goingDark) {
  // goingDark = the NEW state we're going TO
  const icon   = document.getElementById('menuThemeIcon');
  const label  = document.getElementById('menuThemeLabel');
  const sw     = document.getElementById('menuThemeSwitch');
  const btn    = document.getElementById('menuThemeBtn');
  if (!sw) return;

  // 1. Update pill (CSS handles knob slide + bg transition)
  sw.classList.toggle('light-mode', !goingDark);

  // 2. Shine sweep
  if (sw) {
    sw.classList.remove('sweep'); void sw.offsetWidth;
    sw.classList.add('sweep');
    setTimeout(() => sw.classList.remove('sweep'), 450);
  }

  // 4. Ripple
  if (btn) {
    btn.classList.remove('ripple'); void btn.offsetWidth;
    btn.classList.add('ripple');
    setTimeout(() => btn.classList.remove('ripple'), 450);
  }

  // 5. Icon spin — spin OUT old, spin IN new
  if (icon) {
    icon.className = '';
    void icon.offsetWidth;
    icon.innerHTML = goingDark ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0" ><path d="M14.5 10.5A7 7 0 0 1 6 1.5a7 7 0 1 0 8.5 9z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0" ><circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="1" x2="8" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="13.5" x2="8" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="8" x2="2.5" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="13.5" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="3.1" y1="3.1" x2="4.2" y2="4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11.8" y1="11.8" x2="12.9" y2="12.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11.8" y1="4.2" x2="12.9" y2="3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="3.1" y1="12.9" x2="4.2" y2="11.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    icon.className = goingDark ? 'menu-theme-icon-to-dark' : 'menu-theme-icon-to-light';
  }

  // 6. Text flip — old slides up out, new slides in from below
  const inner = label && label.querySelector('.lbl-inner');
  if (inner) {
    inner.classList.remove('lbl-flip-out', 'lbl-flip-in');
    void inner.offsetWidth;
    inner.classList.add('lbl-flip-out');
    setTimeout(() => {
      inner.textContent = goingDark ? 'Dark Mode' : 'Light Mode';
      inner.classList.remove('lbl-flip-out');
      void inner.offsetWidth;
      inner.classList.add('lbl-flip-in');
      setTimeout(() => inner.classList.remove('lbl-flip-in'), 300);
    }, 160);
  }

  // 7. Particles
  const particles = document.getElementById('themeParticles');
  if (particles) {
    particles.innerHTML = '';
    const colors = goingDark
      ? ['#7c6bff','#a78bfa','#c4b5fd','#e0d9ff']
      : ['#00d4aa','#34d399','#ffd166','#ff9a3c'];
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('div');
      const ang = (i/8)*360, dst = 18+Math.random()*10;
      const sz = 3+Math.random()*3;
      p.className = 'theme-particle';
      p.style.cssText = `width:${sz}px;height:${sz}px;background:${colors[i%4]};left:50%;top:50%;margin-left:-${sz/2}px;margin-top:-${sz/2}px;--tx:${Math.cos(ang*Math.PI/180)*dst}px;--ty:${Math.sin(ang*Math.PI/180)*dst}px;animation-delay:${i*0.02}s`;
      particles.appendChild(p);
    }
    setTimeout(() => { if(particles) particles.innerHTML=''; }, 600);
  }
}

function _syncMenuToggle() {
  // Silent sync — no animation, just update state
  const isDark = !document.documentElement.classList.contains('light');
  const sw    = document.getElementById('menuThemeSwitch');
  const icon  = document.getElementById('menuThemeIcon');
  const inner = document.querySelector('#menuThemeLabel .lbl-inner');
  if (sw)    sw.classList.toggle('light-mode', !isDark);
  if (icon)  icon.innerHTML = isDark ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="3" y1="3" x2="4.5" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11.5" y1="11.5" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 9.5A6 6 0 016 2a6 6 0 000 12 6 6 0 007.5-4.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (inner) inner.textContent = isDark ? 'Dark Mode' : 'Light Mode';
}

document.getElementById('menuThemeBtn')?.addEventListener('click', () => {
  const goingDark = document.documentElement.classList.contains('light'); 
  toggleTheme(); 
  _applyMenuToggle(goingDark); 
});

const _origRefreshUI = window._refreshThemeUI;
window._refreshThemeUI = function() {
  if (typeof _origRefreshUI === 'function') _origRefreshUI();
  _syncMenuToggle();
};

function updateMenuThemeLabel() { _syncMenuToggle(); } 

function updateNotifMenuLabel() {
  const label = document.getElementById('menuNotifLabel');
  const arrow = document.getElementById('menuNotifArrow');
  if (!label) return;
  if (Notification.permission === 'granted') {
    label.textContent = 'Reminders On';
    if (arrow) arrow.style.color = 'var(--accent3)';
  } else if (Notification.permission === 'denied') {
    label.textContent = 'Notifications Blocked';
    if (arrow) arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:block"><path d="M7 2L1 12h12L7 2z" fill="rgba(255,77,109,.15)" stroke="#ff4d6d" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6" x2="7" y2="9" stroke="#ff4d6d" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11" r=".8" fill="#ff4d6d"/></svg>';
  } else {
    label.textContent = 'Enable Reminders';
    if (arrow) arrow.style.color = '';
  }
}

updateNotifMenuLabel();

function _syncNotifToggle(){
  const sw=document.getElementById('menuNotifSwitch');
  const inner=document.querySelector('#menuNotifLabel .notif-lbl-inner');
  const perm=(typeof Notification!=='undefined')?Notification.permission:'default';
  const off=localStorage.getItem('ft_reminders_off')==='1';
  const on=perm==='granted'&&!off;
  if(sw){ sw.classList.remove('on','blocked'); if(on) sw.classList.add('on'); else if(perm==='denied') sw.classList.add('blocked'); }
  if(inner) inner.textContent=on?'Reminders On':perm==='denied'?'Notifications Blocked':'Enable Reminders';
}
function _applyNotifToggle(goingOn){
  const sw=document.getElementById('menuNotifSwitch');
  const btn=document.getElementById('menuNotifBtn');
  const icon=document.getElementById('menuNotifIcon');
  const label=document.getElementById('menuNotifLabel');
  if(!sw) return;
  sw.classList.remove('on','blocked');
  if(goingOn) sw.classList.add('on');
  sw.classList.remove('sweep'); void sw.offsetWidth; sw.classList.add('sweep');
  setTimeout(()=>sw.classList.remove('sweep'),450);
  if(btn){ btn.classList.remove('ripple'); void btn.offsetWidth; btn.classList.add('ripple'); setTimeout(()=>btn.classList.remove('ripple'),450); }
  if(icon){ icon.style.transition='transform .32s cubic-bezier(.34,1.5,.64,1)'; icon.style.transform='scale(1.35) rotate('+(goingOn?'18':'-18')+'deg)'; setTimeout(()=>{icon.style.transform='scale(1) rotate(0)';},320); }
  const inner=label&&label.querySelector('.notif-lbl-inner');
  if(inner){
    inner.classList.remove('lbl-flip-out','lbl-flip-in'); void inner.offsetWidth;
    inner.classList.add('lbl-flip-out');
    setTimeout(()=>{
      inner.textContent=goingOn?'Reminders On':(Notification.permission==='denied'?'Notifications Blocked':'Enable Reminders');
      inner.classList.remove('lbl-flip-out'); void inner.offsetWidth;
      inner.classList.add('lbl-flip-in');
      setTimeout(()=>inner.classList.remove('lbl-flip-in'),300);
    },160);
  }
  const particles=document.getElementById('notifParticles');
  if(particles){
    particles.innerHTML='';
    const cols=goingOn?['#00d4aa','#34d399','#a7f3d0','#6ee7b7']:['#ff4d6d','#ff6b9d','#fca5a5','#fcd34d'];
    for(let i=0;i<8;i++){
      const p=document.createElement('div');
      const ang=(i/8)*360,dst=18+Math.random()*10,sz=3+Math.random()*3;
      p.className='theme-particle';
      p.style.cssText=`width:${sz}px;height:${sz}px;background:${cols[i%4]};left:50%;top:50%;margin-left:-${sz/2}px;margin-top:-${sz/2}px;--tx:${Math.cos(ang*Math.PI/180)*dst}px;--ty:${Math.sin(ang*Math.PI/180)*dst}px;animation-delay:${i*0.02}s`;
      particles.appendChild(p);
    }
    setTimeout(()=>{if(particles)particles.innerHTML='';},600);
  }
}

document.getElementById('menuNotifBtn')?.addEventListener('click',async()=>{
  const perm=(typeof Notification!=='undefined')?Notification.permission:'default';
  const off=localStorage.getItem('ft_reminders_off')==='1';
  const on=perm==='granted'&&!off;
  if(on){
    
    localStorage.setItem('ft_reminders_off','1');
    _applyNotifToggle(false);
    toast('Reminders turned off','');
    
  } else if(perm==='denied'){
    _applyNotifToggle(false);
    toast('Enable notifications in browser settings','error');
    
  } else if(perm==='granted'&&off){
    
    localStorage.removeItem('ft_reminders_off');
    _applyNotifToggle(true);
    toast('Reminders on','success');
    
  } else {
    
    _applyNotifToggle(true);
    setTimeout(async()=>{
      await initNotifications();
      if(Notification.permission==='granted'){
        localStorage.removeItem('ft_reminders_off');
        toast('Reminders enabled','success');
      } else {
        _syncNotifToggle(); 
      }
    },340);
    
  }
});

window._cooldown = _cooldown;
window.getCacheUid = getCacheUid;
window.toast = toast;

const _origCheckDue=checkDueReminder;
window._checkDueReminder=function(force=false){
  if(localStorage.getItem('ft_reminders_off')==='1') return;
  _origCheckDue(force).catch(()=>{});
};

let selMode=false, selItems=new Set(), selContext=''; 

function _allCards(){
  return document.querySelectorAll(
    '#appInner .teacher-card[data-id],' +
    '#appInner .batch-card[data-id],' +
    '#appInner .standalone-card[data-id],' +
    '#bdBody .student-card[data-id]'
  );
}

function _ensureSelRow(card){
  
  if(card.querySelector('.sel-row')) return;
  const id = card.dataset.id;
  const row = document.createElement('div');
  row.className = 'sel-row';
  row.innerHTML = `<div class="sel-circle" onclick="event.stopPropagation();selTap('${id}')"><span class="sel-tick"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="display:block"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>`;
  card.insertBefore(row, card.firstChild);
}

function enterSelMode(context, firstId){
  selMode = true; selContext = context; selItems.clear();
  selItems.add(firstId);

  document.getElementById('appInner')?.classList.add('sel-active');
  document.body.classList.add('sel-active');
  document.getElementById('selBar').classList.remove('hidden');

  _allCards().forEach(card => {
    card.classList.add('sel-mode');
    _ensureSelRow(card);
  });
  _applySelState(firstId, true);
  updateSelBar();
}

function exitSelMode(){
  selMode = false; selItems.clear(); selContext = '';

  document.getElementById('appInner')?.classList.remove('sel-active');
  document.body.classList.remove('sel-active');
  document.getElementById('selBar').classList.add('hidden');

  _allCards().forEach(card => {
    card.classList.remove('sel-mode', 'selected');
    const circle = card.querySelector('.sel-circle');
    if(circle) circle.classList.remove('checked');
  });
}

function _applySelState(id, selected){
  const card = document.querySelector(
    `[data-id="${id}"].teacher-card,[data-id="${id}"].batch-card,` +
    `[data-id="${id}"].student-card,[data-id="${id}"].standalone-card`
  );
  if(!card) return;
  card.classList.toggle('selected', selected);
  const circle = card.querySelector('.sel-circle');
  if(circle) circle.classList.toggle('checked', selected);
}

function toggleSelItem(id){
  const nowSelected = !selItems.has(id);
  if(nowSelected) selItems.add(id); else selItems.delete(id);
  _applySelState(id, nowSelected);
  if(!selItems.size){ exitSelMode(); return; }
  updateSelBar();
}
function updateSelBar(){
  document.getElementById('selCount').textContent=selItems.size;
  const assignBtn=document.getElementById('selAssignBtn');
  
  assignBtn.classList.toggle('hidden', selContext!=='student');
}

(function initLongPressDelegate(){
  const HOLD_MS = 600;
  let _timer = null;
  let _startCard = null;
  let _moved = false;

  function cardFrom(el){
    return el?.closest('.teacher-card[data-id],.batch-card[data-id],.student-card[data-id]');
  }

  let _startX, _startY;
  function onStart(e){
    const card = cardFrom(e.target);
    if(!card) return;
    if(selMode){
      
      return;
    }
    _moved = false;
    _startCard = card;
    const touch = e.touches?.[0];
    _startX = touch ? touch.clientX : e.clientX;
    _startY = touch ? touch.clientY : e.clientY;
    _timer = setTimeout(()=>{
      _timer = null;
      if(_moved || !_startCard) return;
      const id = _startCard.dataset.id;
      if(!id) return;
      const ctx = _startCard.classList.contains('teacher-card')
        ? 'teacher' : _startCard.classList.contains('batch-card')
        ? 'batch' : 'student';
      if(navigator.vibrate) navigator.vibrate(32);
      
      _startCard._suppressClick = true;
      setTimeout(()=>{ if(_startCard) _startCard._suppressClick = false; }, 600);
      enterSelMode(ctx, id);
    }, HOLD_MS);
  }

  function onMove(e){
    const touch = e.touches?.[0];
    if (touch && _startX !== undefined) {
      const dx = touch.clientX - _startX, dy = touch.clientY - _startY;
      if (Math.hypot(dx, dy) < 8) return; 
    }
    _moved = true;
    if(_timer){ clearTimeout(_timer); _timer = null; }
  }
  function onEnd(){  if(_timer){ clearTimeout(_timer); _timer = null; } _startCard = null; }

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove',  onMove,  { passive: true });
  document.addEventListener('touchend',   onEnd,   { passive: true });
  document.addEventListener('mousedown',  onStart);
  document.addEventListener('mouseup',    onEnd);
  document.addEventListener('mousemove',  e => { if(e.buttons) onMove(); });

  document.addEventListener('click', e => {
    const card = cardFrom(e.target);
    if(card && card._suppressClick){ e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
})();

window.selTap=function(id){
  if(!selMode) return false;
  toggleSelItem(id);
  return true;
};

Object.defineProperty(window,'selMode',{ get:()=>selMode });

document.getElementById('selBarClose')?.addEventListener('click',exitSelMode);

document.getElementById('selDeleteBtn')?.addEventListener('click',async()=>{
  const ids=[...selItems];
  const label=ids.length===1?'this item':`${ids.length} items`;
  if(!await confirm2('Delete',`Remove ${label}? This cannot be undone.`,'Delete',_CI.del)) return;
  for(const id of ids){
    if(selContext==='teacher'){
      await Promise.all(payments.filter(p=>p.teacherId===id).map(p=>deleteDoc(pyDoc(p.id))));
      await deleteDoc(tcDoc(id));
      payments=payments.filter(p=>p.teacherId!==id);
      delete teachers[id];
    } else if(selContext==='batch'){
      await deleteDoc(btDoc(id));
      try { idbSet('_batchDetailTs_'+id, null); } catch(e){}
      delete batches[id];
    } else if(selContext==='student'){
      await deleteDoc(stuDoc(currentBatchId,id));
      _invalidateBatchCache(currentBatchId);
      delete batchStudents[id];
    }
  }
  saveToCache();
  toast(`Deleted ${ids.length} item${ids.length>1?'s':''}` ,'');
  exitSelMode();
  if(selContext==='student') renderBatchDetail(currentBatchId);
  else render();
  selContext='';
});

let _assignStudentIds=[];
document.getElementById('selAssignBtn')?.addEventListener('click',()=>{
  _assignStudentIds=[...selItems];
  const list=document.getElementById('assignBatchList');
  let h='';
  let _selBatch='';
  Object.keys(batches).forEach(bid=>{
    const b=batches[bid];
    h+=`<div class="batch-pick-item" data-bid="${bid}" onclick="toggleBatchPick(this,'${bid}')">
      <div class="batch-pick-icon" style="display:flex;align-items:center;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M1 5a2 2 0 0 1 2-2h3.5l1.5 2H13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity=".08"/></svg></div>
      <div>
        <div class="batch-pick-name">${b.name}</div>
        <div class="batch-pick-sub">${b.class||''} · ${fmt(b.fee)}/mo${b.timing?' · '+b.timing:''}</div>
      </div>
    </div>`;
  });
  list.innerHTML=h||'<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No batches yet — create one first.</div>';
  document.getElementById('assignBatchModal').classList.remove('hidden');
});
window.toggleBatchPick=function(el,bid){
  document.querySelectorAll('.batch-pick-item').forEach(x=>x.classList.remove('sel'));
  el.classList.add('sel');
  el._selBid=bid;
};
document.getElementById('closeAssignBatchBtn')?.addEventListener('click',()=>document.getElementById('assignBatchModal').classList.add('hidden'));
document.getElementById('cancelAssignBatchBtn')?.addEventListener('click',()=>document.getElementById('assignBatchModal').classList.add('hidden'));
document.getElementById('confirmAssignBatchBtn')?.addEventListener('click',async()=>{
  const sel=document.querySelector('.batch-pick-item.sel');
  if(!sel){ toast('Select a batch first','error'); return; }
  const bid=sel.dataset.bid||sel._selBid;
  if(bid==='__new__'){
    document.getElementById('assignBatchModal').classList.add('hidden');
    toast('Create a batch first, then assign',''); openAddBatchModal(); return;
  }
  const btn=document.getElementById('confirmAssignBatchBtn');
  btn.disabled=true; btn.textContent='Moving…';
  try{
    const now=new Date(),bm=now.getMonth()+1,by=now.getFullYear();
    for(const sid of _assignStudentIds){
      if(_assignIsStandalone){
        
        const s=_standaloneStudents.find(x=>x.id===sid)||{};
        await addDoc(stuCol(bid),{name:s.name||'Student',baselineMonth:s.baselineMonth||bm,baselineYear:s.baselineYear||by,fee:s.fee,lastPaidDate:s.lastPaidDate||null,createdAt:Date.now(),feeStatus:'never'});
        await deleteDoc(doc(db,'users',uid(),'students',sid));
      } else {
        
        const st=batchStudents[sid]||{name:'Student',baselineMonth:bm,baselineYear:by};
        await addDoc(stuCol(bid),{name:st.name,baselineMonth:st.baselineMonth||bm,baselineYear:st.baselineYear||by,createdAt:Date.now(),feeStatus:'never'});
      }
    }
    _invalidateBatchCache(bid);
    try { idbSet('_standaloneStudentsTs', null); } catch(e){}
    if(_assignIsStandalone){
      _standaloneStudents=_standaloneStudents.filter(s=>!_assignStudentIds.includes(s.id));
      _renderStandaloneSection();
    }
    toast(`Moved to ${batches[bid].name} ✓`,'success');
    document.getElementById('assignBatchModal').classList.add('hidden');
    _assignIsStandalone=false;
    exitSelMode();
    await loadBatchDetail(bid);
  }catch(e){ toast('Error: '+e.message,'error'); }
  btn.disabled=false; btn.textContent='Move to Batch';
});

window.openAddStandaloneStudent = function openAddStandaloneStudent(){
  const sel=document.getElementById('ssBatchSel');
  sel.innerHTML='<option value="">No batch — standalone</option>';
  Object.keys(batches).forEach(bid=>{
    const opt=document.createElement('option');
    opt.value=bid; opt.textContent=batches[bid].name;
    sel.appendChild(opt);
  });
  ['ssNameInp','ssFeeInp'].forEach(i=>{const e=document.getElementById(i);if(e)e.value='';});
  ['ssDateInp','ssPayDateInp'].forEach(i=>{const e=document.getElementById(i);if(e)e.value='';});
  document.getElementById('addStandaloneStudentModal').classList.remove('hidden');
  setTimeout(()=>document.getElementById('ssNameInp')?.focus(),200);
}
document.getElementById('closeStandaloneStudentBtn')?.addEventListener('click',()=>document.getElementById('addStandaloneStudentModal').classList.add('hidden'));
document.getElementById('cancelStandaloneStudentBtn')?.addEventListener('click',()=>document.getElementById('addStandaloneStudentModal').classList.add('hidden'));
document.getElementById('confirmStandaloneStudentBtn')?.addEventListener('click',async()=>{
  const nm=document.getElementById('ssNameInp').value.trim();
  const fe=parseInt(document.getElementById('ssFeeInp').value);
  const dv=document.getElementById('ssDateInp').value;
  const pdv=document.getElementById('ssPayDateInp').value;
  const bid=document.getElementById('ssBatchSel').value;
  if(!nm) return toast('Enter student name','error');
  if(!fe) return toast('Enter monthly fee','error');
  const btn=document.getElementById('confirmStandaloneStudentBtn');
  btn.disabled=true; btn.textContent='Adding…';
  try{
    const now=new Date(),bm=now.getMonth()+1,by=now.getFullYear();
    const sd={name:nm,fee:fe,createdAt:Date.now(),feeStatus:'never'};
    if(pdv){ const pp=pdv.split('-'); sd.baselineMonth=parseInt(pp[1]); sd.baselineYear=parseInt(pp[0]); sd.lastPaidDate=pdv; }
    else if(dv){ const dp=dv.split('-'); sd.baselineMonth=parseInt(dp[1]); sd.baselineYear=parseInt(dp[0]); }
    else { sd.baselineMonth=bm; sd.baselineYear=by; }
    if(dv){ const dp=dv.split('-'); sd.admissionDay=parseInt(dp[2]); sd.admissionMonth=parseInt(dp[1]); sd.admissionYear=parseInt(dp[0]); }
    if(bid){
      
      await addDoc(stuCol(bid),sd);
      _invalidateBatchCache(bid);
      toast(`${nm} added to ${batches[bid].name} ✓`,'success');
    } else {
      
      const _newRef = await addDoc(collection(db,'users',uid(),'students'),sd);
      
      _standaloneStudents.push({id:_newRef.id,...sd});
      idbSet('standalone_students',_standaloneStudents);
      try { idbSet('_standaloneStudentsTs', Date.now()); } catch(e){}
      toast(`${nm} added ✓`,'success');
    }
    document.getElementById('addStandaloneStudentModal').classList.add('hidden');
    if(bid) {
      await loadBatchDetail(bid);
    } else {
      _renderStandaloneSection();
    }
  }catch(e){ toast('Error: '+e.message,'error'); }
  btn.disabled=false; btn.textContent='Add Student';
});

function _patchedRenderStudent(){
  
  const root=document.getElementById('appInner');
  const td=totalDue(), n=new Date();
  const ds=n.toLocaleDateString(USER_LOCALE,{day:'numeric',month:'long',year:'numeric'});
  const ov=Object.keys(teachers).filter(id=>monthsDue(id)>0).length;
  const cl=Object.keys(teachers).filter(id=>monthsDue(id)===0).length;
  let h=`
    ${!profile.className?`<div class="setup-banner" onclick="openProfileModal()"><span class="setup-banner-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><circle cx="9" cy="6" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M2 16c0-3.9 3.1-6 7-6s7 2.1 7 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><div class="setup-banner-text"><div class="setup-banner-title">Complete your profile</div><div class="setup-banner-sub">Add your name and class</div></div><button class="setup-banner-btn">Set up</button></div>`:''}
    <div class="total-card" id="totalCard" style="cursor:pointer" onclick="handleTotalCardClick(event)">
      <div class="total-label">Total Outstanding</div>
      <div class="total-amount"><span class="cur"></span><span id="totalAmtDisplay" data-target="${td}">0</span></div>
      <div class="total-sub" id="totalDateSub">As of ${ds}</div>
      <div class="total-meta" id="totalMeta">
        <div class="total-meta-item total-meta-item--pending" id="metaPending" onclick="event.stopPropagation();filterByStatus('pending')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show pending teachers">
          <div class="total-meta-val" id="metaPendingVal">${ov}</div>
          <div class="total-meta-lbl">Pending</div>
        </div>
        <div class="total-meta-item total-meta-item--clear" id="metaClear" onclick="event.stopPropagation();filterByStatus('clear')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show clear teachers">
          <div class="total-meta-val" id="metaClearVal">${cl}</div>
          <div class="total-meta-lbl">Clear</div>
        </div>
        <div class="total-meta-item total-meta-item--all" id="metaAll" onclick="event.stopPropagation();filterByStatus('all')" style="cursor:pointer;transition:transform .15s,opacity .15s;" title="Show all teachers">
          <div class="total-meta-val" id="metaAllVal">${Object.keys(teachers).length}</div>
          <div class="total-meta-lbl">Teachers</div>
        </div>
      </div>
    </div>
    <div class="search-wrap">
      <span class="search-icon"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg></span>
      <input class="search-input" type="text" placeholder="Search teacher or subject…" value="${searchQ}" oninput="onSearch(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}" />
      ${searchQ?`<span class="search-clear" onclick="onSearch('');this.previousElementSibling.value='';this.previousElementSibling.focus();" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;background:var(--surface3);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);z-index:2;"><svg width='11' height='11' viewBox='0 0 12 12' fill='none' style='display:block'><line x1='1' y1='1' x2='11' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/><line x1='11' y1='1' x2='1' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/></svg></span>`:''}
    </div>
    <div class="section-label"><span class="section-label-txt">Teachers</span><span class="section-label-count" id="teachers-count">${Object.keys(teachers).length}</span></div>
    <div id="cards-list">`;
  if(!Object.keys(teachers).length){
    h+=`<div class="empty-state"><div class="empty-icon" style="display:flex;align-items:center;justify-content:center;margin-bottom:14px;"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div><div class="empty-title">No teachers yet</div><div class="empty-sub">Tap <strong>+</strong> to add your first teacher and start tracking.</div></div>`;
    root.innerHTML=h; return;
  }
  
  let sorted=Object.keys(teachers).sort((a,b)=>{
    return calcDue(b)-calcDue(a);
  }).filter(id=>{ const q=searchQ.toLowerCase(); return !q||teachers[id].name.toLowerCase().includes(q)||teachers[id].subject.toLowerCase().includes(q); });
  if(!sorted.length){ h+=`<div class="no-results">No results for "<strong>${searchQ}</strong>"</div></div>`; root.innerHTML=h; return; }
  let dl=0;
  
  const _pbtPRS = {};
  payments.forEach(p => { (_pbtPRS[p.teacherId] = _pbtPRS[p.teacherId] || []).push(p); });
  for(const id of sorted){
    const t=teachers[id],dm=monthsDue(id),da=calcDue(id),lps=lastPaidStr(id),ov2=dm>=3,cr=dm>=6,pb=partialBal(id);
    const tpy=(_pbtPRS[id]||[]).sort((a,b)=>b.timestamp-a.timestamp);
    const bdg=cr?`<span class="overdue-badge critical"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".7" fill="currentColor"/></svg>${dm}mo</span>`:ov2?`<span class="overdue-badge"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M7 2L0.5 13h13L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="6.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="11.2" r=".65" fill="currentColor"/></svg>${dm}mo</span>`:'';
    const isSel=selItems.has(id);
    h+=`<div class="teacher-card ${cr?'card-critical':ov2?'card-overdue':''}" data-id="${id}" style="animation-delay:${dl}s"
        onclick="if(selMode){event.stopPropagation();selTap('${id}');return;}openTeacherDetail('${id}')">
        <div class="card-top">
          <div class="card-header">
            <div class="card-left">
              <div class="teacher-name-row"><div class="teacher-name">${t.name}</div>${bdg}</div>
              <div class="teacher-subject">${t.subject} · ${fmt(t.fee)}/mo</div>
              ${lps?`<div class="last-paid">Last paid: ${lps}</div>`:`<div class="last-paid never">Never paid</div>`}
            </div>
            <div class="due-badge">
              <div class="due-amount ${da===0?'zero':cr?'critical':''}">${fmt(da)}</div>
              <div class="due-months">${dm===0?'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>All clear':`${dm} month${dm>1?'s':''} due`}</div>
              ${pb>0?`<div class="partial-chip">+${fmt(pb)} partial</div>`:''}
            </div>
          </div>
        </div>
        ${selMode?'':`<div class="tc-tap-hint">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6 8h4M8 6v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Tap to pay, view history &amp; more
        </div>`}
      ${selMode?'':'<div class="card-chevron"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'}
      </div>`;
    dl+=0.05;
  }
  h+='</div>';
  root.innerHTML=h;

}

function _patchedRenderTeacher(){
  const root=document.getElementById('appInner');
  const subjs=profile.subjects||[],classes=profile.classes||[],sess=profile.session||'',bList=Object.keys(batches);
  const subjLine=[subjs.length?subjs.join(', '):'No subjects set',classes.length?classes.join(', '):'',sess].filter(Boolean).join(' · ');
  let h=`
    ${!profile.displayName?`<div class="setup-banner" onclick="openProfileModal()"><span class="setup-banner-icon"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M26 9L5 21l21 12 21-12L26 9z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 30l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/><path d="M5 39l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/></svg></span><div class="setup-banner-text"><div class="setup-banner-title">Set up your teacher profile</div><div class="setup-banner-sub">Add your subjects and session</div></div><button class="setup-banner-btn">Set up</button></div>`:''}
    <div class="teacher-mode-header" onclick="window.openTeacherDash&&window.openTeacherDash()" style="cursor:pointer"><div class="tmh-icon"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M26 9L5 21l21 12 21-12L26 9z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 30l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/><path d="M5 39l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/></svg></div><div class="tmh-info"><div class="tmh-title">Teacher Dashboard</div><div class="tmh-sub">${subjLine}</div></div>

    </div>
    <div class="search-wrap"><span class="search-icon"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"/></svg></span><input class="search-input" type="text" placeholder="Search batch…" value="${searchQ}" oninput="onSearch(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}" />${searchQ?`<span class="search-clear" onclick="onSearch('');this.previousElementSibling.value='';this.previousElementSibling.focus();" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;background:var(--surface3);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);z-index:2;"><svg width='11' height='11' viewBox='0 0 12 12' fill='none' style='display:block'><line x1='1' y1='1' x2='11' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/><line x1='11' y1='1' x2='1' y2='11' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/></svg></span>`:''}</div>
    <div class="section-label"><span class="section-label-txt">My Batches</span><span class="section-label-count">${bList.length}</span></div>`;
  if(!bList.length){ h+=`<div class="empty-state"><div class="empty-icon"><svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M26 9L5 21l21 12 21-12L26 9z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 30l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/><path d="M5 39l21 12 21-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/></svg></div><div class="empty-title">No batches yet</div><div class="empty-sub">Tap <strong>+</strong> to create a batch, then add students and track fees.</div></div>`; root.innerHTML=h; return; }
  const fil=bList.filter(id=>{const q=searchQ.toLowerCase();return !q||batches[id].name.toLowerCase().includes(q)||batches[id].subject?.toLowerCase().includes(q);}).sort((a,b)=>{
    return 0;
  });
  let dl=0;
  for(const bid of fil){const b=batches[bid];
    const isSel=selItems.has(bid);
    h+=`<div class="batch-card" data-id="${bid}" style="animation-delay:${dl}s"
      onclick="if(selMode){event.stopPropagation();selTap('${bid}');return;}openBatchDetail('${bid}')" ontouchstart="void 0">
      <div class="batch-header"><div><div class="batch-name">${b.name}</div><div class="batch-meta">${b.class?b.class+' · ':''} ${fmt(b.fee)}/mo per student${b.timing?' · '+b.timing:''}</div></div>${b.session?`<span class="batch-session-badge">${b.session}</span>`:''}</div>
      <div class="batch-subject-list">${b.subject.split(',').map(s=>`<span class="batch-subj-chip">${s.trim()}</span>`).join('')}</div>
      ${selMode?'':`<div class="batch-actions">
        <button class="batch-open-btn" onclick="event.stopPropagation();openBatchDetail('${bid}')" style="display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0" ><path d="M11 13v-1a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M14 13v-1a3 3 0 0 0-2-2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> View students ›</button>
        <button class="batch-del-btn" onclick="event.stopPropagation();deleteBatch('${bid}')"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex-shrink:0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
      </div>`}
    </div>`;dl+=0.05;}
  root.innerHTML=h;
  // Load and render standalone students asynchronously after batches
  loadAndRenderStandaloneStudents(root);
}

async function loadAndRenderStandaloneStudents(root){
  try{
    const snap=await getDocs(collection(db,'users',uid(),'students'));
    if(snap.empty) return;
    const studs=[];
    snap.forEach(d=>studs.push({id:d.id,...d.data()}));
    const section=document.createElement('div');
    section.id='standaloneStudentsSection';
    section.style.cssText='margin-top:18px';
    const now2=new Date(),curM2=now2.getMonth()+1,curY2=now2.getFullYear();
    let sh=`<div class="section-label" style="margin-bottom:10px"><span class="section-label-txt">Individual Students</span><span class="section-label-count">${studs.length}</span></div>`;
    studs.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).forEach((s,i)=>{
      const fee=s.fee||0;
      const bm=s.baselineMonth||curM2,by=s.baselineYear||curY2;
      const lp={month:bm,year:by};
      const mo=Math.max(mBetween(lp,{month:curM2,year:curY2}),0);
      const due=Math.max(mo*fee,0);
      sh+=`<div class="student-card" style="animation-delay:${i*0.05}s" data-id="${s.id}" data-standalone="1"
        onclick="if(selMode){selTap('${s.id}');return;}">
        <div class="sc-top">
          <div class="sc-header">
            <div class="sc-left">
              <div class="sc-name-row">
                <div class="sc-avatar">${(s.name||'S')[0].toUpperCase()}</div>
                <div class="sc-name">${s.name||'Student'}</div>
              </div>
              <div class="sc-meta">Individual · ${fmt(fee)}/mo</div>
              ${s.lastPaidDate?`<div class="sc-last-paid">Last paid: ${s.lastPaidDate}</div>`:'<div class="sc-last-paid never">Never paid</div>'}
            </div>
            <div class="sc-due-badge">
              <div class="sc-due-amt ${due===0?'zero':''}">${fmt(due)}</div>
              <div class="sc-due-mo">${mo===0?'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>All clear':`${mo} month${mo>1?'s':''} due`}</div>
            </div>
          </div>
        </div>
        <div class="sc-actions">
          <div style="flex:1;padding:9px 13px;font-size:11px;color:var(--muted)">No batch assigned</div>
          <button class="sc-edit-btn" onclick="event.stopPropagation();assignStandaloneToExistingBatch('${s.id}','${(s.name||'').replace(/'/g,"\'")}')"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
          <button class="sc-del-btn" onclick="event.stopPropagation();deleteStandaloneStudent('${s.id}','${(s.name||'').replace(/'/g,"\'")}')"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>`;
    });
    section.innerHTML=sh;
    // Remove old section if exists, then append
    const old=root.querySelector('#standaloneStudentsSection');
    if(old) old.remove();
    const appInner=document.getElementById('appInner');
    if(appInner) appInner.appendChild(section);
  }catch {}
}

window.deleteStandaloneStudent=async function(sid,name){
  if(!await confirm2('Remove Student',`Remove <strong style="color:#f0f0f8">${name}</strong>?`,'Remove',_CI.rem)) return;
  try{
    await deleteDoc(doc(db,'users',uid(),'students',sid));
    try { idbSet('_standaloneStudentsTs', null); } catch(e){}
    toast(`${name} removed`,''); loadAndRenderStandaloneStudents(document.getElementById('appInner'));
  }
  catch(e){ toast('Error: '+e.message,'error'); }
};

window.assignStandaloneToExistingBatch=async function(sid,name){
  const bKeys=Object.keys(batches);
  if(!bKeys.length){ toast('Create a batch first','error'); return; }
  const list=document.getElementById('assignBatchList');
  let ah='';
  bKeys.forEach(bid=>{ const b=batches[bid]; ah+=`<div class="batch-pick-item" data-bid="${bid}" onclick="toggleBatchPick(this,'${bid}')"><div class="batch-pick-icon" style="display:flex;align-items:center;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><path d="M1 5a2 2 0 0 1 2-2h3.5l1.5 2H13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity=".08"/></svg></div><div><div class="batch-pick-name">${b.name}</div><div class="batch-pick-sub">${fmt(b.fee)}/mo per student</div></div></div>`; });
  list.innerHTML=ah;
  _assignStudentIds=[sid];
  // Override confirm to handle standalone correctly
  document.getElementById('confirmAssignBatchBtn').onclick=async()=>{
    const sel=document.querySelector('.batch-pick-item.sel');
    if(!sel){ toast('Select a batch','error'); return; }
    const bid=sel.dataset.bid;
    const btn=document.getElementById('confirmAssignBatchBtn');
    btn.disabled=true; btn.textContent='Moving…';
    try{
      const snap2=await getDoc(doc(db,'users',uid(),'students',sid));
      const sd=snap2.exists()?snap2.data():{};
      const now3=new Date();
      await addDoc(stuCol(bid),{name:sd.name||name,baselineMonth:sd.baselineMonth||now3.getMonth()+1,baselineYear:sd.baselineYear||now3.getFullYear(),fee:sd.fee,lastPaidDate:sd.lastPaidDate||null,createdAt:Date.now(),feeStatus:'never'});
      await deleteDoc(doc(db,'users',uid(),'students',sid));
      _invalidateBatchCache(bid);
      try { idbSet('_standaloneStudentsTs', null); } catch(e){}
      toast(`${name} moved to ${batches[bid].name} ✓`,'success');
      document.getElementById('assignBatchModal').classList.add('hidden');
      loadAndRenderStandaloneStudents(document.getElementById('appInner'));
    }catch(e){ toast('Error: '+e.message,'error'); }
    btn.disabled=false; btn.textContent='Move to Batch';
  };
  document.getElementById('assignBatchModal').classList.remove('hidden');
};

// Override render to use patched versions
const _origRenderStudent=renderStudent, _origRenderTeacher=renderTeacher;
window.renderStudent=_patchedRenderStudent;
window.renderTeacher=_patchedRenderTeacher;
window._patchedRenderStudent=_patchedRenderStudent;
window._patchedRenderTeacher=_patchedRenderTeacher;

// ─── add payment date field to saveAllStudents ───
// saveAllStudents uses pendingStudents which includes payDate via addOnePending patch

// Patch addOnePending to include pay date
const _origAddOne=addOnePending;
window.addOnePending=function(){
  const pdv=document.getElementById('newStudentPayDateInp')?.value||'';
  // The original reads name/date/feeStatus/lastPaid
  // Inject payDate into the pending item after push
  const before=pendingStudents.length;
  _origAddOne();
  if(pendingStudents.length>before){
    pendingStudents[pendingStudents.length-1].payDate=pdv;
    // Reset pay date field
    const pdi=document.getElementById('newStudentPayDateInp');
    if(pdi) pdi.value='';
  }
};

// Patch saveAllStudents to use payDate for baseline
const _origSaveAllStudents=saveAllStudents;

// ═══════════════════════════════════════════════════
//  DASHBOARD — teacher & student
// ═══════════════════════════════════════════════════
let _tchDashCharts=[],_stuDashCharts=[];
function dashFmt(n){ return fmt(Number(n)); }
function isDarkMode(){ return !document.documentElement.classList.contains('light'); }
function chartDefaults(){
  const dark=isDarkMode(),tc=dark?'rgba(255,255,255,.55)':'rgba(30,30,60,.6)',gc=dark?'rgba(255,255,255,.04)':'rgba(0,0,0,.05)';
  return { responsive:true, maintainAspectRatio:false, animation:{duration:700,easing:'easeInOutQuart'},
    plugins:{ legend:{labels:{color:tc,font:{family:"'DM Sans'",size:11},padding:12}},
      tooltip:{backgroundColor:dark?'#1c1c38':'#fff',titleColor:dark?'#ebebf5':'#18182e',bodyColor:dark?'#8e8eb8':'#4e4e82',borderColor:dark?'rgba(255,255,255,.12)':'rgba(80,80,140,.15)',borderWidth:1,cornerRadius:10,padding:10}},
    scales:{ x:{ticks:{color:tc,font:{size:10}},grid:{color:gc}}, y:{ticks:{color:tc,font:{size:10}},grid:{color:gc}} } };
}
function destroyCharts(arr){ arr.forEach(c=>{try{c.destroy();}catch(e){}});arr.length=0; }

// openTeacherDash defined below with skeleton support
async function fetchAllBatchStats(){
  const stats={};
  await Promise.all(Object.keys(batches).map(async bid=>{
    try{ const [ss,ps]=await Promise.all([getDocs(stuCol(bid)),getDocs(bpyCol(bid))]);
      const stus={},pays=[]; ss.forEach(d=>stus[d.id]=d.data()); ps.forEach(d=>pays.push({id:d.id,...d.data()}));
      stats[bid]={students:stus,payments:pays}; }catch(e){stats[bid]={students:{},payments:[]};}
  })); return stats;
}
async function renderTeacherDash(){
  // destroyCharts called by close or open — not here (avoids double-destroy)
  const body=document.getElementById('teacherDashBody'); if(!body)return;
  const bKeys=Object.keys(batches);
  if(!bKeys.length){ body.innerHTML='<div class="dash-empty"><div class="dash-empty-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="40" height="40" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div><div class="dash-empty-txt">No batches yet.</div></div>'; return; }
  body.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);">Loading…</div>';
  const allStats=await fetchAllBatchStats();
  const now=new Date(),curM=now.getMonth()+1,curY=now.getFullYear();
  const batchSummaries=[],allPays=[];
  let grandDue=0,grandStudents=0,grandPaid=0,grandMonthly=0;
  for(const bid of bKeys){
    const b=batches[bid],s=allStats[bid]||{students:{},payments:[]};
    const stuKeys=Object.keys(s.students); let bDue=0,bPaid=0;
    s.payments.forEach(p=>allPays.push(p));
    stuKeys.forEach(sid=>{
      const st=s.students[sid],fee=b.fee||0;
      let lp={month:st.baselineMonth||curM,year:st.baselineYear||curY},rp=0;
      s.payments.filter(p=>p.studentId===sid).sort((a,x)=>a.timestamp-x.timestamp).forEach(p=>{
        if(p.type==='partial'){rp+=p.amount;const c=Math.floor(rp/fee);if(c>0){lp=addM(lp,c);rp%=fee;}}
        else if(p.monthsPaid){lp=addM(lp,p.monthsPaid);rp=0;}
      });
      const mo=Math.max(mBetween(lp,{month:curM,year:curY}),0);
      const _dayAdj=(mo>0&&now.getDate()<(lp.day||1))?1:0;
      const moAdj=Math.max(mo-_dayAdj,0);
      let pb=0; s.payments.filter(p=>p.studentId===sid).sort((a,x)=>a.timestamp-x.timestamp).forEach(p=>{if(p.type==='partial'){pb+=p.amount;pb%=fee;}else if(p.monthsPaid)pb=0;});
      const due=Math.max(moAdj*fee-pb,0); bDue+=due; if(due===0)bPaid++;
    });
    grandDue+=bDue; grandStudents+=stuKeys.length; grandPaid+=bPaid; grandMonthly+=stuKeys.length*(b.fee||0);
    batchSummaries.push({bid,name:b.name,stuCount:stuKeys.length,paidCount:bPaid,dueCount:stuKeys.length-bPaid,due:bDue});
  }
  const collRate=grandStudents>0?Math.round((grandPaid/grandStudents)*100):0;
  
  const standaloneCount = (typeof _standaloneStudents !== 'undefined') ? _standaloneStudents.length : 0;
  grandStudents += standaloneCount;
  const overdueStu=grandStudents-grandPaid;
  const monthLabels=[],monthAmts=[];
  for(let i=5;i>=0;i--){const d=new Date(curY,curM-1-i,1);monthLabels.push(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]);monthAmts.push(allPays.filter(p=>p.paidOn&&p.paidOn.month===d.getMonth()+1&&p.paidOn.year===d.getFullYear()).reduce((s,p)=>s+(p.amount||0),0));}
  const overdueList=[];
  batchSummaries.forEach(bs=>{const s=allStats[bs.bid],b=batches[bs.bid],fee=b.fee||0;Object.keys(s.students).forEach(sid=>{const st=s.students[sid];let lp={month:st.baselineMonth||curM,year:st.baselineYear||curY},rp=0;s.payments.filter(p=>p.studentId===sid).sort((a,x)=>a.timestamp-x.timestamp).forEach(p=>{if(p.type==='partial'){rp+=p.amount;const c=Math.floor(rp/fee);if(c>0){lp=addM(lp,c);rp%=fee;}}else if(p.monthsPaid){lp=addM(lp,p.monthsPaid);rp=0;}});const mo=Math.max(mBetween(lp,{month:curM,year:curY}),0);const _oda=(mo>0&&now.getDate()<(lp.day||1))?1:0;const moAdj2=Math.max(mo-_oda,0);let pb=0;s.payments.filter(p=>p.studentId===sid).sort((a,x)=>a.timestamp-x.timestamp).forEach(p=>{if(p.type==='partial'){pb+=p.amount;pb%=fee;}else if(p.monthsPaid)pb=0;});const due=Math.max(moAdj2*fee-pb,0);if(due>0)overdueList.push({name:st.name,batch:b.name,due,mo:moAdj2});});});
  overdueList.sort((a,b)=>b.due-a.due);
  const dark=isDarkMode(),tc=dark?'rgba(255,255,255,.55)':'rgba(30,30,60,.6)',gc=dark?'rgba(255,255,255,.04)':'rgba(0,0,0,.05)';
  body.innerHTML=`
    <div class="dash-stat-grid">
      <div class="dash-stat-card" style="--stat-glow:rgba(124,107,255,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 2L2 7l9 5 9-5-9-5z" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M2 12l9 5 9-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/></svg></div><div class="dash-stat-val">${grandStudents}</div><div class="dash-stat-label">Total Students</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(0,212,170,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="6" width="18" height="13" rx="3" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.6"/><path d="M7 6V4a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div><div class="dash-stat-val">${bKeys.length}</div><div class="dash-stat-label">Active Batches</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,209,102,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><path d="M8 7.5h6M8 7.5v1a4.5 4.5 0 0 0 4.5 4.5M8 7.5h2a2.5 2.5 0 0 1 0 5H8M10.5 13l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div><div class="dash-stat-val" style="font-size:19px">${dashFmt(grandMonthly)}</div><div class="dash-stat-label">Monthly Potential</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,77,109,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 2L1 20h20L11 2z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><line x1="11" y1="9" x2="11" y2="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="11" cy="16.5" r="1.1" fill="currentColor"/></svg></div><div class="dash-stat-val" style="font-size:19px;color:${grandDue>0?'var(--yellow)':'var(--accent3)'}">${dashFmt(grandDue)}</div><div class="dash-stat-label">Outstanding Dues</div></div>
    </div>
    <div class="dash-two-col">
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Collection Rate</div><div class="dash-chart-sub">Students paid vs pending</div>
          <div style="display:flex;align-items:center;gap:20px;padding-top:8px">
            <div class="dash-canvas-wrap" style="width:120px;height:120px;flex-shrink:0"><canvas id="tchDonutChart"></canvas></div>
            <div><div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;letter-spacing:-1.5px;color:${collRate>=80?'var(--accent3)':collRate>=50?'var(--yellow)':'var(--red)'}">${collRate}%</div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:10px">of students paid</div>
              <div style="font-size:12px;color:var(--accent3);margin-bottom:4px">✓ ${grandPaid} paid</div>
              <div style="font-size:12px;color:var(--red)">${overdueStu} pending</div>
            </div>
          </div>
        </div>
        <div class="dash-chart-card"><div class="dash-chart-title">Monthly Revenue</div><div class="dash-chart-sub">Last 6 months collected</div><div class="dash-canvas-wrap" style="height:160px;margin-top:8px"><canvas id="tchLineChart"></canvas></div></div>
      </div>
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Per-Batch Collection</div><div class="dash-chart-sub">Paid vs pending per batch</div><div class="dash-canvas-wrap" style="height:${Math.max(140,bKeys.length*44)}px;margin-top:8px"><canvas id="tchBarChart"></canvas></div></div>
        <div class="dash-insight-card"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.4"/><path d="M4 6h8M4 9h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> Batch Breakdown</div>
          ${batchSummaries.sort((a,b)=>b.due-a.due).map(bs=>{const pct=bs.stuCount>0?Math.round((bs.paidCount/bs.stuCount)*100):0;const fc=pct>=80?'var(--accent3)':pct>=50?'var(--yellow)':'var(--red)';return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--text)">${bs.name}</span><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:800;color:${fc}">${pct}%</span></div><div style="font-size:10px;color:var(--muted);margin-bottom:5px">${bs.stuCount} students · ${dashFmt(bs.due)} due</div><div class="dash-prog-bar"><div class="dash-prog-fill" style="width:${pct}%;background:${fc}"></div></div></div>`;}).join('')}
        </div>
      </div>
    </div>
    ${overdueList.length?`<div class="dash-insight-card" style="margin-top:14px"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5L.5 13h13L7 1.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.5" r=".7" fill="currentColor"/></svg> Top Overdue Students</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">${overdueList.slice(0,8).map((s,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:12px;border:1px solid var(--border)"><div style="width:24px;height:24px;border-radius:50%;background:${i<3?'rgba(255,77,109,.15)':'var(--surface3)'};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:11px;font-weight:800;color:${i<3?'var(--red)':'var(--muted)'};flex-shrink:0">${i+1}</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div><div style="font-size:10px;color:var(--muted)">${s.batch} · ${s.mo}mo</div></div><div style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--red);flex-shrink:0">${dashFmt(s.due)}</div></div>`).join('')}</div></div>`:''}`;
  document.getElementById('teacherDashSub').textContent=`${bKeys.length} batch${bKeys.length!==1?'es':''} · ${grandStudents} students`;
  const dCtx=document.getElementById('tchDonutChart')?.getContext('2d');
  if(dCtx){const cd=chartDefaults();_tchDashCharts.push(new Chart(dCtx,{type:'doughnut',data:{labels:['Paid','Pending'],datasets:[{data:[grandPaid,overdueStu],backgroundColor:['#00d4aa','#ff4d6d'],borderWidth:0,hoverOffset:8}]},options:{...cd,cutout:'72%',scales:{x:{display:false},y:{display:false}},plugins:{...cd.plugins,legend:{display:false}}}}));}
  const bCtx=document.getElementById('tchBarChart')?.getContext('2d');
  if(bCtx){const sorted2=[...batchSummaries].sort((a,b)=>b.stuCount-a.stuCount);const cd=chartDefaults();_tchDashCharts.push(new Chart(bCtx,{type:'bar',data:{labels:sorted2.map(bs=>bs.name.length>14?bs.name.slice(0,14)+'…':bs.name),datasets:[{label:'Paid',data:sorted2.map(bs=>bs.paidCount),backgroundColor:'rgba(0,212,170,.8)',borderRadius:5,borderSkipped:false},{label:'Pending',data:sorted2.map(bs=>bs.dueCount),backgroundColor:'rgba(255,77,109,.7)',borderRadius:5,borderSkipped:false}]},options:{...cd,indexAxis:'y',plugins:{...cd.plugins,legend:{labels:{color:tc,font:{size:10},padding:10}}},scales:{x:{stacked:false,ticks:{color:tc,font:{size:10},stepSize:1},grid:{color:gc}},y:{ticks:{color:tc,font:{size:10}},grid:{display:false}}}}}));}
  const lCtx=document.getElementById('tchLineChart')?.getContext('2d');
  if(lCtx){const cd=chartDefaults();_tchDashCharts.push(new Chart(lCtx,{type:'line',data:{labels:monthLabels,datasets:[{label:'Collected (₹)',data:monthAmts,borderColor:'#7c6bff',backgroundColor:'rgba(124,107,255,.12)',tension:.4,fill:true,pointBackgroundColor:'#7c6bff',pointRadius:4,borderWidth:2}]},options:{...cd,plugins:{...cd.plugins,legend:{display:false}},scales:{x:{ticks:{color:tc,font:{size:10}},grid:{color:gc}},y:{ticks:{color:tc,font:{size:10},callback:v=>v>=1000?'₹'+(v/1000).toFixed(0)+'k':'₹'+v},grid:{color:gc}}}}}));}
}

// openStudentDash/closeStudentDash defined below with skeleton support
window.renderStudentDash=function(){
  // destroyCharts called by open/close — not here
  const body=document.getElementById('studentDashBody'); if(!body)return;
  const tKeys=Object.keys(teachers);
  if(!tKeys.length){ body.innerHTML='<div class="dash-empty"><div class="dash-empty-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="40" height="40" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="6" y="6" width="4" height="40" rx="2" fill="currentColor" opacity=".3"/></svg></div><div class="dash-empty-txt">No teachers yet.</div></div>'; return; }
  const now=new Date(),curM=now.getMonth()+1,curY=now.getFullYear();
  const teacherData=tKeys.map(id=>{const t=teachers[id],dm=monthsDue(id),da=calcDue(id);return{id,name:t.name,subject:t.subject,fee:t.fee,dm,da,cr:dm>=6,ov:dm>=3};}).sort((a,b)=>b.da-a.da);
  const totalDue2=teacherData.reduce((s,t)=>s+t.da,0);
  const clearCount=teacherData.filter(t=>t.dm===0).length,overdueCount=teacherData.filter(t=>t.dm>0).length;
  const totalMonthly=teacherData.reduce((s,t)=>s+t.fee,0);
  const clearRate=tKeys.length>0?Math.round((clearCount/tKeys.length)*100):0;
  const monthLabels2=[],monthAmts2=[];
  for(let i=5;i>=0;i--){const d=new Date(curY,curM-1-i,1);monthLabels2.push(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]);monthAmts2.push(payments.filter(p=>p.paidOn&&p.paidOn.month===d.getMonth()+1&&p.paidOn.year===d.getFullYear()).reduce((s,p)=>s+(p.amount||0),0));}
  const paidThisMonth=payments.filter(p=>p.paidOn&&p.paidOn.month===curM&&p.paidOn.year===curY).reduce((s,p)=>s+(p.amount||0),0);
  const nonZ=monthAmts2.filter(a=>a>0);const avgMonthly=nonZ.length?Math.round(nonZ.reduce((s,a)=>s+a,0)/nonZ.length):0;
  const dark=isDarkMode(),tc=dark?'rgba(255,255,255,.55)':'rgba(30,30,60,.6)',gc=dark?'rgba(255,255,255,.04)':'rgba(0,0,0,.05)';
  body.innerHTML=`
    <div class="dash-stat-grid">
      <div class="dash-stat-card" style="--stat-glow:rgba(255,77,109,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="1" y="5" width="20" height="13" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="13" width="5" height="2" rx="1" fill="currentColor" opacity=".6"/></svg></div><div class="dash-stat-val" style="font-size:20px;color:${totalDue2>0?'var(--yellow)':'var(--accent3)'}">${dashFmt(totalDue2)}</div><div class="dash-stat-label">Total Outstanding</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(0,212,170,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="3" width="18" height="16" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><path d="M6 2v3M16 2v3M2 9h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><polyline points="7,14 10,17 15,12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div class="dash-stat-val" style="font-size:20px;color:var(--accent3)">${dashFmt(paidThisMonth)}</div><div class="dash-stat-label">Paid This Month</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(124,107,255,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="1" y="5" width="20" height="13" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="6" height="2" rx="1" fill="currentColor"/></svg></div><div class="dash-stat-val" style="font-size:20px">${dashFmt(totalMonthly)}</div><div class="dash-stat-label">Monthly Fees</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,209,102,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><polyline points="1,17 6,11 10,14 15,7 21,11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="1" y1="19" x2="21" y2="19" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".4"/></svg></div><div class="dash-stat-val" style="font-size:20px">${dashFmt(avgMonthly)}</div><div class="dash-stat-label">Avg Monthly Paid</div></div>
    </div>
    <div class="dash-two-col">
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Fee Status Overview</div><div class="dash-chart-sub">Teachers — clear vs pending</div>
          <div style="display:flex;align-items:center;gap:20px;padding-top:8px">
            <div class="dash-canvas-wrap" style="width:120px;height:120px;flex-shrink:0"><canvas id="stuDonutChart"></canvas></div>
            <div><div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;letter-spacing:-1.5px;color:${clearRate>=80?'var(--accent3)':totalDue2>0?'var(--yellow)':'var(--accent3)'}">${clearRate}%</div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:10px">fees up to date</div>
              <div style="font-size:12px;color:var(--accent3);margin-bottom:4px">✓ ${clearCount} teacher${clearCount!==1?'s':''} — clear</div>
              <div style="font-size:12px;color:var(--red)">${overdueCount} pending</div>
            </div>
          </div>
        </div>
        <div class="dash-chart-card"><div class="dash-chart-title">Payment History</div><div class="dash-chart-sub">Amount paid — last 6 months</div><div class="dash-canvas-wrap" style="height:160px;margin-top:8px"><canvas id="stuLineChart"></canvas></div></div>
      </div>
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Per-Teacher Dues</div><div class="dash-chart-sub">Months outstanding</div><div class="dash-canvas-wrap" style="height:${Math.max(140,tKeys.length*44)}px;margin-top:8px"><canvas id="stuBarChart"></canvas></div></div>
        <div class="dash-insight-card"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1" y="9" width="4" height="7" rx="1.2" fill="currentColor" opacity=".4"/><rect x="6" y="5" width="4" height="11" rx="1.2" fill="currentColor" opacity=".68"/><rect x="11" y="1" width="4" height="15" rx="1.2" fill="currentColor"/></svg> Teacher-wise Status</div>
          ${teacherData.map(t=>{const fc=t.dm===0?'var(--accent3)':t.cr?'var(--red)':t.ov?'var(--yellow)':'var(--accent4)';return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--text)">${t.name}</span><span style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:${fc}">${dashFmt(t.da)}</span></div><div style="font-size:10px;color:var(--muted);margin-bottom:5px">${t.subject} · ${t.dm===0?'All clear':t.dm+' mo due'}</div><div class="dash-prog-bar"><div class="dash-prog-fill" style="width:${t.dm===0?100:Math.min(100,t.dm*15)}%;background:${fc}"></div></div></div>`;}).join('')}
        </div>
      </div>
    </div>
    ${payments.length?`<div class="dash-insight-card" style="margin-top:14px"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="1.4"/><polyline points="8,4.5 8,8.5 11,10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Recent Payments</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">${[...payments].sort((a,b)=>b.timestamp-a.timestamp).slice(0,6).map(p=>`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:12px;border:1px solid var(--border)"><div style="width:28px;height:28px;border-radius:9px;background:${p.type==='partial'?'rgba(255,154,60,.15)':p.type==='advance'?'rgba(124,107,255,.15)':'rgba(0,212,170,.15)'};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:10px;font-weight:800;color:${p.type==='partial'?'var(--accent4)':p.type==='advance'?'var(--accent)':'var(--accent3)'};flex-shrink:0">${p.type==='partial'?'P':p.type==='advance'?'A':'✓'}</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.teacherName||'Teacher'}</div><div style="font-size:10px;color:var(--muted)">${p.paidOn?p.paidOn.day+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][p.paidOn.month-1]:'—'}</div></div><div style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--accent3);flex-shrink:0">${dashFmt(p.amount)}</div></div>`).join('')}</div></div>`:''}`;
  const dCtx=document.getElementById('stuDonutChart')?.getContext('2d');
  if(dCtx){const cd=chartDefaults();_stuDashCharts.push(new Chart(dCtx,{type:'doughnut',data:{labels:['Clear','Pending'],datasets:[{data:[clearCount,overdueCount],backgroundColor:['#00d4aa','#ff4d6d'],borderWidth:0,hoverOffset:8}]},options:{...cd,cutout:'72%',scales:{x:{display:false},y:{display:false}},plugins:{...cd.plugins,legend:{display:false}}}}));}
  const bCtx=document.getElementById('stuBarChart')?.getContext('2d');
  if(bCtx){const cd=chartDefaults();_stuDashCharts.push(new Chart(bCtx,{type:'bar',data:{labels:teacherData.map(t=>t.name.length>14?t.name.slice(0,14)+'…':t.name),datasets:[{label:'Months Due',data:teacherData.map(t=>t.dm),backgroundColor:teacherData.map(t=>t.cr?'rgba(255,77,109,.8)':t.ov?'rgba(255,209,102,.8)':'rgba(0,212,170,.8)'),borderRadius:5,borderSkipped:false}]},options:{...cd,indexAxis:'y',plugins:{...cd.plugins,legend:{display:false}},scales:{x:{ticks:{color:tc,font:{size:10},stepSize:1},grid:{color:gc}},y:{ticks:{color:tc,font:{size:10}},grid:{display:false}}}}}));}
  const lCtx=document.getElementById('stuLineChart')?.getContext('2d');
  if(lCtx){const cd=chartDefaults();_stuDashCharts.push(new Chart(lCtx,{type:'line',data:{labels:monthLabels2,datasets:[{label:'Paid (₹)',data:monthAmts2,borderColor:'#ff6b9d',backgroundColor:'rgba(255,107,157,.1)',tension:.4,fill:true,pointBackgroundColor:'#ff6b9d',pointRadius:4,borderWidth:2}]},options:{...cd,plugins:{...cd.plugins,legend:{display:false}},scales:{x:{ticks:{color:tc,font:{size:10}},grid:{color:gc}},y:{ticks:{color:tc,font:{size:10},callback:v=>v>=1000?'₹'+(v/1000).toFixed(0)+'k':'₹'+v},grid:{color:gc}}}}}));}
};

document.getElementById('dashBtn')?.addEventListener('click',()=>{ if(isT()) window.openTeacherDash(); else window.openStudentDash(); });

let _editTeacherId='';
window.openEditTeacher=function(id){
  _editTeacherId=id;
  const t=teachers[id];
  document.getElementById('editTeacherNameInp').value=t.name||'';
  document.getElementById('editTeacherSubjectInp').value=t.subject||'';
  document.getElementById('editTeacherFeeInp').value=t.fee||'';
  document.getElementById('editTeacherPayDateInp').value=t.lastPaidDate||'';
  document.getElementById('editTeacherModal').classList.remove('hidden');
};
function closeEditTeacherModal(){ closeModal('editTeacherModal'); }
document.getElementById('closeEditTeacherBtn')?.addEventListener('click',closeEditTeacherModal);
document.getElementById('cancelEditTeacherBtn')?.addEventListener('click',closeEditTeacherModal);
document.getElementById('confirmEditTeacherBtn')?.addEventListener('click',async()=>{
  const nm=document.getElementById('editTeacherNameInp').value.trim();
  const sb=document.getElementById('editTeacherSubjectInp').value.trim();
  const fe=parseInt(document.getElementById('editTeacherFeeInp').value);
  const dv=document.getElementById('editTeacherPayDateInp').value;
  if(!nm||!sb||!fe) return toast('Fill name, subject and fee','error');
  const btn=document.getElementById('confirmEditTeacherBtn');
  btn.disabled=true; btn.textContent='Saving…';
  try{
    const upd={name:nm,subject:sb,fee:fe,lastPaidDate:dv||null};
    if(dv){ const dp=dv.split('-'); upd.baselineMonth=parseInt(dp[1]); upd.baselineYear=parseInt(dp[0]); }
    else { const _p=new Date(new Date().getFullYear(),new Date().getMonth()-1,1); upd.baselineMonth=_p.getMonth()+1; upd.baselineYear=_p.getFullYear(); }
    await updateDoc(tcDoc(_editTeacherId),upd);
    try { idbSet('_lastSyncTs', null); } catch(e){}
    teachers[_editTeacherId]={...teachers[_editTeacherId],...upd};
    saveToCache();
    closeEditTeacherModal();
    toast('Teacher updated ✓','success');
    render();
  }catch(e){ toast('Error: '+e.message,'error'); }
  btn.disabled=false; btn.textContent='Save Changes';
});

let _editSsId='';
document.getElementById('closeEditSsBtn')?.addEventListener('click',()=>document.getElementById('editStandaloneStudentModal').classList.add('hidden'));
document.getElementById('cancelEditSsBtn')?.addEventListener('click',()=>document.getElementById('editStandaloneStudentModal').classList.add('hidden'));
document.getElementById('confirmEditSsBtn')?.addEventListener('click',async()=>{
  const nm=document.getElementById('editSsNameInp').value.trim();
  const fe=parseInt(document.getElementById('editSsFeeInp').value);
  const dv=document.getElementById('editSsDateInp').value;
  const pdv=document.getElementById('editSsPayDateInp').value;
  if(!nm) return toast('Enter name','error');
  if(!fe) return toast('Enter fee','error');
  const btn=document.getElementById('confirmEditSsBtn');
  btn.disabled=true; btn.textContent='Saving…';
  try{
    const upd={name:nm,fee:fe,lastPaidDate:pdv||null};
    if(pdv){ const pp=pdv.split('-'); upd.baselineMonth=parseInt(pp[1]); upd.baselineYear=parseInt(pp[0]); }
    if(dv){ const dp=dv.split('-'); upd.admissionDay=parseInt(dp[2]); upd.admissionMonth=parseInt(dp[1]); upd.admissionYear=parseInt(dp[0]); }
    await updateDoc(doc(db,'users',uid(),'students',_editSsId),upd);
    try { idbSet('_standaloneStudentsTs', null); } catch(e){}
    const idx=_standaloneStudents.findIndex(s=>s.id===_editSsId);
    if(idx>=0) _standaloneStudents[idx]={..._standaloneStudents[idx],...upd};
    document.getElementById('editStandaloneStudentModal').classList.add('hidden');
    toast('Student updated ✓','success');
    _renderStandaloneSection();
  }catch(e){ toast('Error: '+e.message,'error'); }
  btn.disabled=false; btn.textContent='Save Changes';
});

const _origLoadAll=loadAll;
window.loadAll=async function(silent=false, force=false){
  await _origLoadAll(silent, force);
  if(isT()) await loadStandaloneStudents();
};

function dashSkeleton(){
  return `<div style="padding:0">
    <div class="dash-sk-row">
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
    </div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div style="display:flex;gap:16px;align-items:center"><div class="sk" style="width:130px;height:130px;border-radius:50%;flex-shrink:0"></div><div style="flex:1"><div class="sk" style="width:60%;height:32px;border-radius:8px;margin-bottom:8px"></div><div class="sk" style="width:80%;height:10px;border-radius:5px;margin-bottom:6px;opacity:.6"></div><div class="sk" style="width:70%;height:10px;border-radius:5px;opacity:.4"></div></div></div></div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div class="sk" style="width:100%;height:160px;border-radius:10px"></div></div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div class="sk" style="width:100%;height:160px;border-radius:10px"></div></div>
  </div>`;
}

window.openTeacherDash=async function(force=false){
  screenFadeTo('teacherDashScreen','appScreen');
  document.getElementById('teacherDashBody').innerHTML=dashSkeleton();
  const btn=document.getElementById('teacherDashRefresh'); if(btn)btn.classList.add('spinning');
  try{ await renderTeacherDash(); }
  catch(e){ const b=document.getElementById('teacherDashBody'); if(b) b.innerHTML=`<div style="text-align:center;padding:40px;color:var(--red);font-size:13px;">Failed to load dashboard.<br><small style="color:var(--muted)">${e.message}</small></div>`; }
  if(btn)setTimeout(()=>btn.classList.remove('spinning'),600);
};
window.closeTeacherDash=function(){
  destroyCharts(_tchDashCharts);
  screenFadeTo('appScreen','teacherDashScreen');
  window.sbSetActive?.('sbHome'); sbSetPage?.('home');
};
window.openStudentDash=function(){
  screenFadeTo('studentDashScreen','appScreen');
  document.getElementById('studentDashBody').innerHTML=dashSkeleton();
  renderStudentDash();
};
window.closeStudentDash=function(){
  destroyCharts(_stuDashCharts);
  screenFadeTo('appScreen','studentDashScreen');
  window.sbSetActive?.('sbHome'); sbSetPage?.('home');
};

let _countUpRaf = null;
function runTotalCountUp(){
  if(isT()) return;
  const el = document.getElementById('totalAmtDisplay');
  if(!el) return;
  if(_countUpRaf){ cancelAnimationFrame(_countUpRaf); _countUpRaf=null; }
  const target = totalDue();
  el.classList.add('counting');
  if(target === 0){ el.textContent = '0'; el.classList.remove('counting'); return; }
  el.textContent = '0';
  const digits = String(target).length;
  const duration = Math.min(1200, 600 + digits * 80);
  const startTime = performance.now();
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  function tick(now){
    const progress = Math.min((now - startTime) / duration, 1);
    const current = Math.round(easeOut(progress) * target);
    el.textContent = current.toLocaleString(USER_LOCALE);
    if(progress < 1){ _countUpRaf = requestAnimationFrame(tick); }
    else { el.textContent = target.toLocaleString(USER_LOCALE); el.classList.remove('counting'); _countUpRaf=null; }
  }
  _countUpRaf = requestAnimationFrame(tick);
}

window._activeStatusFilter = 'all';
function _applyMetaHighlight(filter){
  const items = {
    pending: document.getElementById('metaPending'),
    clear:   document.getElementById('metaClear'),
    all:     document.getElementById('metaAll')
  };
  const noFilter = (filter === 'all');
  Object.entries(items).forEach(([k, el])=>{
    if(!el) return;
    const active = !noFilter && (k === filter);
    el.style.transform     = active ? 'scale(1.06)' : 'scale(1)';
    el.style.opacity       = (noFilter || active) ? '1' : '0.62';
    el.style.background    = active ? 'rgba(255,255,255,0.28)' : '';
    el.style.outline       = active ? '2px solid rgba(255,255,255,0.45)' : 'none';
    el.style.outlineOffset = '2px';
  });
}

function updateTotalCard(){
  if(isT()) return;
  const ov = Object.keys(teachers).filter(id=>monthsDue(id)>0).length;
  const cl = Object.keys(teachers).filter(id=>monthsDue(id)===0).length;
  const total = Object.keys(teachers).length;
  const n = new Date();
  const ds = n.toLocaleDateString(USER_LOCALE,{day:'numeric',month:'long',year:'numeric'});
  const dateSub = document.getElementById('totalDateSub');
  if(dateSub) dateSub.textContent = 'As of ' + ds;
  function flashUpdate(id, val){
    const el = document.getElementById(id);
    if(!el || el.textContent === String(val) || el.textContent === fmt(val)) return;
    el.style.transition = 'transform .18s cubic-bezier(.34,1.5,.64,1),opacity .14s';
    el.style.transform = 'scale(1.22)'; el.style.opacity = '0.7';
    setTimeout(()=>{ el.textContent = val; el.style.transform='scale(1)'; el.style.opacity='1'; },90);
  }
  flashUpdate('metaPendingVal', ov);
  flashUpdate('metaClearVal',   cl);
  flashUpdate('metaAllVal',     total);
  runTotalCountUp();
  _applyMetaHighlight(window._activeStatusFilter || 'all');
}

window.filterByStatus = function(status){
  window._activeStatusFilter = status;
  _applyMetaHighlight(status);

  const lbl = document.querySelector('.section-label-txt');
  if(lbl){
    lbl.textContent = status==='pending' ? 'Pending' : status==='clear' ? 'Clear' : 'Teachers';
  }

  const container = document.getElementById('cards-list');
  if(!container) return;

  const allCards = container.querySelectorAll('.teacher-card[data-id]');
  let shownCount = 0;
  allCards.forEach(card=>{
    const id = card.dataset.id;
    if(!id) return;
    let show = true;
    if(status==='pending') show = monthsDue(id) > 0;
    else if(status==='clear') show = monthsDue(id) === 0;
    card.style.display = show ? '' : 'none';
    if(show) shownCount++;
  });

  let noRes = container.querySelector('.filter-empty');
  if(shownCount === 0 && status !== 'all'){
    if(!noRes){
      noRes = document.createElement('div');
      noRes.className = 'no-results filter-empty';
    }
    noRes.textContent = status==='pending' ? 'No pending fees' : 'No cleared teachers yet';
    container.appendChild(noRes);
  } else if(noRes){
    noRes.remove();
  }

  const countEl = document.getElementById('teachers-count');
  if(countEl) countEl.textContent = status === 'all'
    ? Object.keys(teachers).length
    : shownCount;

  try{ if(navigator.vibrate) navigator.vibrate(10); } catch(e){}

  if(status==='pending' && shownCount > 0)
    toast(`${shownCount} pending fee${shownCount>1?'s':''}`, '');
  else if(status==='clear' && shownCount > 0)
    toast(`${shownCount} all-clear ✓`, 'success');
};

window.handleTotalCardClick = function(e){
  
  if(e.target.closest('.total-meta-item')) return;
  
  if(window._activeStatusFilter && window._activeStatusFilter !== 'all'){
    filterByStatus('all');
  } else {
    if(typeof window.openStudentDash === 'function') window.openStudentDash();
  }
};

let _tdsId = null;

function _tdsPayHtml(id){
  const t = teachers[id], dm = monthsDue(id);
  const tabs =
    `<button class="pay-tab ${dm>0?'active':''}" id="tds-ptab-full" onclick="tdsSwitchTab('full')" ${dm===0?'disabled':''}>Full</button>`+
    `<button class="pay-tab" id="tds-ptab-partial" onclick="tdsSwitchTab('partial')" ${dm===0?'disabled':''}>Partial</button>`+
    `<button class="pay-tab ${dm===0?'active-advance':''}" id="tds-ptab-advance" onclick="tdsSwitchTab('advance')" ${dm>0?'disabled':''}>Advance</button>`;
  const rows =
    `<div class="pay-row ${dm===0?'hidden':''}" id="tds-prow-full">`+
      `<input id="tds-pay-full" class="pay-input" type="number" min="1" max="${dm}" `+
      `placeholder="${dm>1?'Months (1\u2013'+dm+')':dm===1?'1 month due':'No dues'}">`+
      `<button class="pay-btn" onclick="tdsPayMonths('full')" ${dm===0?'disabled':''}>Mark</button>`+
    `</div>`+
    `<div class="pay-row hidden" id="tds-prow-partial">`+
      `<input id="tds-pay-partial" class="pay-input" type="number" min="1" max="${t.fee-1}" placeholder="\u20b91 \u2013 \u20b9${t.fee-1}">`+
      `<button class="pay-btn pay-btn-partial" onclick="tdsPayMonths('partial')">Mark</button>`+
    `</div>`+
    `<div class="pay-row ${dm===0?'':'hidden'}" id="tds-prow-advance">`+
      `<input id="tds-pay-advance" class="pay-input" type="number" min="1" max="12" placeholder="Months ahead (1\u201312)">`+
      `<button class="pay-btn pay-btn-advance" onclick="tdsPayMonths('advance')">Mark</button>`+
    `</div>`;
  return { tabs, rows };
}

function _tdsHistHtml(id){
  const tpy = payments.filter(p=>p.teacherId===id).sort((a,b)=>b.timestamp-a.timestamp);
  if(!tpy.length) return '<div class="hist-empty" style="text-align:center;color:var(--muted);font-size:13px;padding:18px 0;">No payments yet</div>';
  return '<div class="swipe-hint">\u2190 swipe to delete</div>' + tpy.map(p=>{
    const hb = p.type==='partial'?`<span class="hist-badge hist-partial">Partial</span>`:
               p.type==='advance'?`<span class="hist-badge hist-advance">Advance</span>`:'';
    const lb = p.type==='partial'?`${fmt(p.amount)} partial`:`${p.monthsPaid} month${p.monthsPaid>1?'s':''}`;
    return `<div class="payment-item" ontouchstart="startSwipe(event,this)" ontouchmove="moveSwipe(event,this)" ontouchend="endSwipe(this,'${p.id}')"><div><div class="pay-months-txt">${lb}${hb}</div><div class="pay-date-txt">${p.paidOn?`${p.paidOn.day} ${MONTHS[p.paidOn.month-1]} ${p.paidOn.year}`:'--'}</div></div><div class="pay-amt-tag">${fmt(p.amount)}</div></div>`;
  }).join('');
}

window.openTeacherDetail = function(id){
  if(selMode) return;
  _tdsId = id;
  const t = teachers[id], dm = monthsDue(id), da = calcDue(id), pb = partialBal(id), lps = lastPaidStr(id);
  const cr = dm>=6, ov2 = dm>=3;
  document.getElementById('tdsName').textContent = t.name;
  document.getElementById('tdsSubject').textContent = t.subject + ' \xb7 \u20b9' + t.fee + '/mo';
  const dueEl = document.getElementById('tdsDueAmt');
  dueEl.textContent = fmt(da);
  dueEl.style.color = da===0?'var(--accent3)':cr?'var(--red)':'var(--text)';
  document.getElementById('tdsDueMonths').textContent = dm===0?'All clear \u2713':dm+' month'+(dm>1?'s':'')+' due';
  const badgeEl = document.getElementById('tdsOverdueBadge');
  badgeEl.innerHTML = cr?'<span class="overdue-badge critical" style="font-size:10px;padding:3px 8px;">\u26a0 Critical</span>':
                      ov2?'<span class="overdue-badge" style="font-size:10px;padding:3px 8px;">\u26a0 Overdue</span>':'';
  const lpEl = document.getElementById('tdsLastPaid');
  lpEl.textContent = lps?'Last paid: '+lps:'Never paid';
  lpEl.style.color = lps?'var(--muted)':'var(--red)';
  document.getElementById('tdsPartialChip').innerHTML = pb>0?`<span class="partial-chip">+${fmt(pb)} partial</span>`:'';
  const { tabs, rows } = _tdsPayHtml(id);
  document.getElementById('tdsPayTabs').innerHTML = tabs;
  document.getElementById('tdsPayRows').innerHTML = rows;
  document.getElementById('tdsHistory').innerHTML = _tdsHistHtml(id);
  document.getElementById('teacherDetailSheet').classList.remove('hidden');
  const inner = document.getElementById('teacherDetailSheetInner');
  if(inner) inner.scrollTop = 0;
};

function closeTeacherDetail(){
  document.getElementById('teacherDetailSheet').classList.add('hidden');
  _tdsId = null;
}

window.tdsSwitchTab = function(type){
  ['full','partial','advance'].forEach(tp=>{
    document.getElementById('tds-prow-'+tp)?.classList.toggle('hidden', tp!==type);
    const btn = document.getElementById('tds-ptab-'+tp);
    if(btn){ btn.classList.remove('active','active-partial','active-advance');
      if(tp===type) btn.classList.add(tp==='partial'?'active-partial':tp==='advance'?'active-advance':'active'); }
  });
};

window.tdsPayMonths = async function(type){
  if(!_tdsId) return;
  const release = await _writeLock('tdspay_'+_tdsId);
  try {
  const id = _tdsId, t = teachers[id], dm = monthsDue(id);
  const n = new Date(), po = {day:n.getDate(), month:n.getMonth()+1, year:n.getFullYear()};
  if(type==='full'){
    if(!dm) return toast('No dues pending \u2713','success');
    const v = parseInt(document.getElementById('tds-pay-full')?.value);
    if(!v||v<1||v>dm) return toast('Enter 1\u2013'+dm,'error');
    const amt = v*t.fee;
    if(!await confirm2('Confirm Payment',`Mark <strong style="color:#f0f0f8">${fmt(amt)}</strong> for <strong style="color:#f0f0f8">${v} month${v>1?'s':''}</strong> to ${t.name}?`,'Mark',_CI.pay)) return;
    const p={teacherId:id,teacherName:t.name,subject:t.subject,monthsPaid:v,amount:amt,type:'full',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){
      p.id='local_'+Date.now(); payments.push(p); saveToCache();
      addDoc(pyCol(),p).catch(()=>{});
      toast(`Paid ${fmt(amt)}  (queued)`,'success');
    } else {
      const ref=await addDoc(pyCol(),p); p.id=ref.id; payments.push(p); saveToCache();
      toast(`Paid ${fmt(amt)} \u2713`,'success');
    }
  } else if(type==='partial'){
    const amt = parseInt(document.getElementById('tds-pay-partial')?.value);
    if(!amt||amt<1) return toast('Enter an amount','error');
    if(amt>=t.fee) return toast('Use Full tab for \u20b9'+t.fee+'+','error');
    const tot = partialBal(id)+amt;
    if(tot>=t.fee) return toast('Total covers full month — use Full tab','error');
    if(!await confirm2('Partial Payment',`Record <strong style="color:#f0f0f8">${fmt(amt)}</strong> partial to ${t.name}?<br><small style="color:var(--muted)">Still owed: ${fmt((t.fee-tot))}</small>`,'Record',_CI.part)) return;
    const p={teacherId:id,teacherName:t.name,subject:t.subject,amount:amt,type:'partial',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){ p.id='local_'+Date.now(); payments.push(p); saveToCache(); addDoc(pyCol(),p).catch(()=>{}); toast('Partial '+fmt(amt)+' queued','success'); }
    else { const ref=await addDoc(pyCol(),p); p.id=ref.id; payments.push(p); saveToCache();
    toast('Partial '+fmt(amt)+' recorded','success'); }
  } else if(type==='advance'){
    if(dm>0) return toast('Clear dues first','error');
    const v = parseInt(document.getElementById('tds-pay-advance')?.value);
    if(!v||v<1||v>12) return toast('Enter 1\u201312 months','error');
    const amt = v*t.fee;
    if(!await confirm2('Advance Payment',`Pay <strong style="color:#f0f0f8">${fmt(amt)}</strong> advance for <strong style="color:#f0f0f8">${v} month${v>1?'s':''}</strong> to ${t.name}?`,'Pay',_CI.adv)) return;
    const p={teacherId:id,teacherName:t.name,subject:t.subject,monthsPaid:v,advanceMonths:v,amount:amt,type:'advance',paidOn:po,timestamp:Date.now()};
    if(!navigator.onLine){ p.id='local_'+Date.now(); payments.push(p); saveToCache(); addDoc(pyCol(),p).catch(()=>{}); toast('Advance '+fmt(amt)+' queued','success'); }
    else { const ref=await addDoc(pyCol(),p); p.id=ref.id; payments.push(p); saveToCache();
    toast('Advance '+fmt(amt)+' paid ✓','success'); }
  }
  setTimeout(updateTotalCard, 80);
  renderCards();
  if(!document.getElementById('teacherDetailSheet').classList.contains('hidden'))
    window.openTeacherDetail(id);
  } finally { release(); }
};

document.getElementById('tdsCloseBtn')?.addEventListener('click', closeTeacherDetail);
document.getElementById('teacherDetailSheet')?.addEventListener('click', e=>{
  if(e.target===document.getElementById('teacherDetailSheet')) closeTeacherDetail();
});
document.getElementById('tdsEditBtn')?.addEventListener('click', ()=>{
  if(!_tdsId) return;
  const id=_tdsId; closeTeacherDetail(); window.openEditTeacher(id);
});
document.getElementById('tdsDeleteBtn')?.addEventListener('click', async()=>{
  if(!_tdsId) return;
  const id=_tdsId; closeTeacherDetail(); await window.deleteTeacher(id);
});
window.closeTeacherDetail = closeTeacherDetail;

_syncNotifToggle();

(function initDesktopSidebar() {
  const sidebar = document.getElementById('desktopSidebar');
  if (!sidebar) return;
  const isDesktop = () => window.innerWidth >= 960;
  function applyLayout() {
    
    const signedIn = !!localStorage.getItem('ft_uid');
    const onLoginPage = document.body.classList.contains('page-login') ||
                        document.body.classList.contains('page-onboard');
    sidebar.style.display = (isDesktop() && signedIn && !onLoginPage) ? 'flex' : 'none';
  }
  applyLayout();
  window.addEventListener('resize', applyLayout);
  window._sbRefreshLayout = applyLayout;
})();

function sbSetPage(page) {
  document.body.classList.remove('page-login','page-onboard','page-home','page-analytics','page-history');
  document.body.classList.add('page-'+page);
  window._sbRefreshLayout?.();
}

window.sbSetActive = function(id) {
  document.querySelectorAll('#desktopSidebar .sb-item').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
};

window.sbGoHome = function() {
  try { if(typeof closeBatchDetail==='function') closeBatchDetail(); } catch(e){}
  ['batchDetailScreen','teacherDashScreen','studentDashScreen','historyScreen']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('appScreen')?.classList.remove('hidden');
  sbSetActive('sbHome');
  sbSetPage('home');
};

window.sbGoAnalytics = function() {
  if(typeof isT === 'function' && isT()) {
    if(typeof window.openTeacherDash === 'function') window.openTeacherDash();
  } else {
    if(typeof window.openStudentDash === 'function') window.openStudentDash();
  }
  sbSetActive('sbAnalytics');
  sbSetPage('analytics');
};

window.sbGoHistory = function() {
  if(typeof window.openHistoryScreen === 'function') window.openHistoryScreen();
  sbSetActive('sbHistory');
  sbSetPage('history');
};

window.sbOpenProfile = function() {
  if(typeof openProfileModal === 'function') openProfileModal();
  sbSetActive('sbProfile');
};

window.sbToggleUserMenu = function() {
  const m = document.getElementById('sbUserMenu');
  if (!m) return;
  const isOpen = m.style.display !== 'none';
  m.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    
    setTimeout(() => {
      document.addEventListener('click', function _c(){ m.style.display='none'; document.removeEventListener('click',_c); });
    }, 10);
  }
};
window.sbCloseSideUserMenu = function() {
  const m = document.getElementById('sbUserMenu');
  if (m) m.style.display = 'none';
};

window._syncSidebarUser = function(user) {
  const av    = document.getElementById('sbUserAv');
  const name  = document.getElementById('sbUserName');
  const email = document.getElementById('sbUserEmail');
  if (!av || !name) return;
  const displayName = user?.displayName || profile?.displayName || 'User';
  const photoURL    = user?.photoURL || null;
  const emailStr    = user?.email || profile?.email || '';
  if (photoURL) {
    av.innerHTML = `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    av.textContent = displayName[0].toUpperCase();
    av.style.background = 'linear-gradient(135deg, var(--accent), #5240e0)';
    av.style.color = '#fff';
    av.style.display = 'flex';
    av.style.alignItems = 'center';
    av.style.justifyContent = 'center';
    av.style.fontFamily = "'Syne', sans-serif";
    av.style.fontWeight = '700';
    av.style.fontSize = '13px';
  }
  name.textContent  = displayName;
  if (email) email.textContent = emailStr;
  window._sbRefreshLayout?.();
};

sbSetPage('home');

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const si = document.getElementById('teacherSearchInp') || document.getElementById('searchInp');
    if (si) { si.focus(); si.select(); }
  }
});

document.getElementById('searchTopbarBtn')?.addEventListener('click',()=>{
  const inp = document.querySelector('#appInner .search-input');
  if(inp){
    inp.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(()=>inp.focus(),180);
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const tag = e.target.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
  const type = (e.target.type || '').toLowerCase();
  e.target.blur();
}, false);

(function initBackHandler(){
  
  history.pushState({ ftLayer: 0 }, '');

  window.addEventListener('popstate', e => {
    
    const layers = [
      
      { el: ()=>{ const s=document.getElementById('teacherDashScreen'); return s&&!s.classList.contains('hidden')?s:null; }, close: ()=>{ destroyCharts(_tchDashCharts); document.getElementById('teacherDashScreen').classList.add('hidden'); document.getElementById('appScreen').classList.remove('hidden'); } },
      { el: ()=>{ const s=document.getElementById('studentDashScreen'); return s&&!s.classList.contains('hidden')?s:null; }, close: ()=>{ destroyCharts(_stuDashCharts); document.getElementById('studentDashScreen').classList.add('hidden'); document.getElementById('appScreen').classList.remove('hidden'); } },
      
      { el: ()=>{ const s=document.getElementById('batchDetailScreen'); return s&&!s.classList.contains('hidden')?s:null; }, close: ()=>closeBatchDetail() },
      
      { el: ()=>{ const m=document.getElementById('addModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeAddModal() },
      { el: ()=>{ const m=document.getElementById('addStudentModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeAddStudentModal() },
      { el: ()=>{ const m=document.getElementById('editStudentModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeEditStudentModal() },
      { el: ()=>{ const m=document.getElementById('profileModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeProfileModal() },
      { el: ()=>{ const m=document.getElementById('teacherAddChoiceSheet'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>document.getElementById('teacherAddChoiceSheet').classList.add('hidden') },
      { el: ()=>{ const m=document.getElementById('assignBatchModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>document.getElementById('assignBatchModal').classList.add('hidden') },
      { el: ()=>{ const m=document.getElementById('addStandaloneStudentModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>document.getElementById('addStandaloneStudentModal').classList.add('hidden') },
      { el: ()=>{ const m=document.getElementById('editTeacherModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>document.getElementById('editTeacherModal').classList.add('hidden') },
      { el: ()=>{ const m=document.getElementById('editStandaloneStudentModal'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>document.getElementById('editStandaloneStudentModal').classList.add('hidden') },
      
      { el: ()=>{ const m=document.getElementById('userMenu'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeMenu() },
      
      { el: ()=>{ const m=document.getElementById('teacherDetailSheet'); return m&&!m.classList.contains('hidden')?m:null; }, close: ()=>closeTeacherDetail() },
      
      { el: ()=>selMode?true:null, close: ()=>exitSelMode() },
    ];

    let handled = false;
    for (const layer of layers) {
      try {
        if (layer.el()) {
          layer.close();
          handled = true;
          break;
        }
      } catch(err){}
    }

    if(handled) history.pushState({ ftLayer: 0 }, '');
  });
})();

(function initSearchPlaceholder(){
  let _t = null, _idx = 0;
  let _phCache = null; 
  function getPH(){
    if (_phCache) return _phCache;
    const base = isT() ? ['Search batch or subject…'] : ['Search teacher or subject…'];
    const items = isT()
      ? Object.values(batches).flatMap(b=>[b.name,...(b.subject||'').split(',').map(s=>s.trim())]).filter(Boolean)
      : Object.values(teachers).flatMap(t=>[t.name,t.subject]).filter(Boolean);
    [...new Set(items)].slice(0,6).forEach(v=>base.push('Try "'+v+'"'));
    _phCache = base;
    return base;
  }
  
  window._searchPlaceholderReset = function(){ _phCache = null; _idx = 0; };
  function cycle(){
    const inp = document.querySelector('#appInner .search-input');
    if(!inp || document.activeElement===inp || (window.searchQ||'')) return;
    const ph = getPH();
    _idx = (_idx+1) % ph.length;
    inp.setAttribute('placeholder', ph[_idx]);
  }
  window._searchPHStart = function(){
    clearInterval(_t);
    _idx = 0;
    _t = setInterval(cycle, 2800);
  };
  window._searchPHStop = function(){ clearInterval(_t); };
  document.addEventListener('visibilitychange',()=>{ document.hidden?window._searchPHStop():window._searchPHStart(); });
})();

let _histFilter = 'all'; let _histBatch = 'all'; let _histPeriod = 'all';

window.openHistoryScreen = function(){
  const hs = document.getElementById('historyScreen');
  if (!hs) return;
  hs.classList.remove('hidden');
  hs.style.opacity = '0';
  void hs.offsetHeight;
  hs.style.transition = 'opacity .2s ease';
  hs.style.opacity = '1';
  setTimeout(() => hs.style.transition = '', 220);
  _histFilter = 'all'; _histBatch = 'all'; _histPeriod = 'all';
  _renderHistory();
};

window.closeHistoryScreen = function(){
  const hs = document.getElementById('historyScreen');
  if (!hs) return;
  hs.style.transition = 'opacity .18s ease';
  hs.style.opacity = '0';
  setTimeout(() => {
    hs.classList.add('hidden');
    hs.style.opacity = '';
    hs.style.transition = '';
  }, 190);
  window.sbSetActive?.('sbHome'); sbSetPage?.('home');
};

window._setHistFilter  = function(f){ _histFilter  = f; _renderHistory(); };
window._setHistBatch   = function(b){ _histBatch   = b; _histFilter='all'; _renderHistory(); };
window._setHistPeriod  = function(p){ _histPeriod  = p; _histBatch='all'; _histFilter='all'; _renderHistory(); };

function _renderHistory(){
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const filEl = document.getElementById('histFilters');
  const conEl = document.getElementById('histContent');
  if (!filEl || !conEl) return;
  const now = new Date();

  let allPays = [];
  if (!isT()) {
    allPays = payments.map(p => ({
      ...p,
      _name: teachers[p.teacherId]?.name || p.teacherName || 'Teacher',
      _sub : teachers[p.teacherId]?.subject || '',
      _batch: '',
    }));
  } else {
    allPays = payments.map(p => ({
      ...p,
      _name : p.studentName || batchStudents?.[p.studentId]?.name || 'Student',
      _sub  : batches?.[p.batchId]?.name || 'Standalone',
      _batch: p.batchId || 'standalone',
    }));
  }

  let periodFiltered = allPays;
  if (_histPeriod === 'this') {
    periodFiltered = allPays.filter(p => {
      const d = p.paidOn ? new Date(p.paidOn.year,(p.paidOn.month||1)-1,1) : new Date(p.timestamp);
      return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    });
  } else if (_histPeriod === 'prev') {
    const pm = now.getMonth()-1 < 0 ? 11 : now.getMonth()-1;
    const py = now.getMonth()-1 < 0 ? now.getFullYear()-1 : now.getFullYear();
    periodFiltered = allPays.filter(p => {
      const d = p.paidOn ? new Date(p.paidOn.year,(p.paidOn.month||1)-1,1) : new Date(p.timestamp);
      return d.getMonth()===pm && d.getFullYear()===py;
    });
  }

  let batchFiltered = periodFiltered;
  if (isT() && _histBatch !== 'all') {
    batchFiltered = periodFiltered.filter(p =>
      (_histBatch === 'standalone' ? !p.batchId : p.batchId === _histBatch)
    );
  }

  const shown = batchFiltered;
  shown.sort((a,b) => b.timestamp - a.timestamp);

  const periodRow = `<div class="hist-filter-row" style="margin-bottom:8px">
    ${[['all','All time'],['this','This month'],['prev','Last month']].map(([k,l]) =>
      `<div class="hist-filter-chip${_histPeriod===k?' active':''}" onclick="_setHistPeriod('${k}')">${l}</div>`
    ).join('')}
  </div>`;

  // Row 2: batch chips (teacher) or type chips (student)
  let row2 = '';
  if (isT()) {
    // Batch chips
    const batchChips = [['all', 'All batches', periodFiltered.length]];
    const bNames = {};
    periodFiltered.forEach(p => {
      const bid = p.batchId || 'standalone';
      const bname = p._sub || 'Standalone';
      if (!bNames[bid]) bNames[bid] = { name: bname, count: 0 };
      bNames[bid].count++;
    });
    Object.entries(bNames).sort((a,b)=>b[1].count-a[1].count).forEach(([bid,{name,count}]) => {
      batchChips.push([bid, name, count]);
    });
    row2 = `<div class="hist-filter-row" style="margin-bottom:8px">
      ${batchChips.map(([k,l,c]) =>
        `<div class="hist-filter-chip${_histBatch===k?' active':''}" onclick="_setHistBatch('${k}')" style="${k==='all'?'':'max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'}">${l}${c!==undefined?` <span style="opacity:.6">${c}</span>`:''}</div>`
      ).join('')}
    </div>`;
  }

  const typeBase = isT() ? batchFiltered : periodFiltered;
  const cts = {
    all    : typeBase.length,
    full   : typeBase.filter(p=>!p.type||p.type==='full').length,
    partial: typeBase.filter(p=>p.type==='partial').length,
    advance: typeBase.filter(p=>p.type==='advance').length,
  };
  const typeRow = '';

  filEl.innerHTML = periodRow + row2 + typeRow;

  if (!shown.length) {
    conEl.innerHTML = `<div class="hist-empty-state">
      <div class="hist-empty-icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="1.5" opacity=".2"/><polyline points="24,13 24,24 30,28" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="hist-empty-txt">No payments found</div>
      <div class="hist-empty-sub">Try changing the filters above.</div>
    </div>`;
    return;
  }

  const grps = {};
  shown.forEach(p => {
    const d = p.paidOn ? new Date(p.paidOn.year,(p.paidOn.month||1)-1,p.paidOn.day||1) : new Date(p.timestamp);
    const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    if (!grps[key]) grps[key] = { label:MONTHS[d.getMonth()]+' '+d.getFullYear(), pays:[], total:0 };
    grps[key].pays.push(p);
    grps[key].total += p.amount||0;
  });

  const ICON = {
    full   :`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="9" rx="2" fill="currentColor" opacity=".15" stroke="currentColor" stroke-width="1.4"/><line x1="1.5" y1="7.5" x2="14.5" y2="7.5" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="10" width="4" height="1.5" rx=".75" fill="currentColor"/></svg>`,
    partial:`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="9" rx="2" fill="currentColor" opacity=".15" stroke="currentColor" stroke-width="1.4"/><line x1="1.5" y1="7.5" x2="14.5" y2="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    advance:`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.4"/><path d="M5 10l3-4 3 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  let out = '';
  Object.keys(grps).sort().reverse().forEach(key => {
    const g = grps[key];
    out += `<div class="hist-month-group">
      <div class="hist-month-label"><span>${g.label}</span><span class="hist-month-total">${fmt(g.total)}</span></div>`;
    g.pays.forEach(p => {
      const t = p.type||'full', ic = ICON[t]||ICON.full;
      const d = p.paidOn ? `${p.paidOn.day||1} ${MONTHS[(p.paidOn.month||1)-1]}` : new Date(p.timestamp).toLocaleDateString(USER_LOCALE,{day:'numeric',month:'short'});
      const mo = p.monthsPaid ? ` · ${p.monthsPaid} mo` : '';
      const sub2 = isT() ? (p._sub || 'Standalone') : (p._sub || '');
      out += `<div class="hist-row">
        <div class="hist-row-icon ${t}">${ic}</div>
        <div class="hist-row-body">
          <div class="hist-row-name">${p._name}</div>
          <div class="hist-row-sub">${sub2}${d?' · '+d:''}${mo}</div>
        </div>
        <div class="hist-row-amt">${fmt((p.amount||0))}</div>
      </div>`;
    });
    out += '</div>';
  });
  conEl.innerHTML = out;
}

window.exportHistoryCSV = function(){
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();

  let allPays = [];
  if (!isT()) {
    allPays = payments.map(p => ({
      date: p.paidOn?`${p.paidOn.year}-${String(p.paidOn.month).padStart(2,'0')}-${String(p.paidOn.day||1).padStart(2,'0')}`:new Date(p.timestamp).toISOString().slice(0,10),
      name: teachers[p.teacherId]?.name||p.teacherName||'Teacher',
      sub:  teachers[p.teacherId]?.subject||'',
      type: p.type||'full', months:p.monthsPaid||1, amt:p.amount||0,
      ts: p.timestamp, paidOn: p.paidOn, batchId: null,
    }));
  } else {
    allPays = payments.map(p => ({
      date: p.paidOn?`${p.paidOn.year}-${String(p.paidOn.month).padStart(2,'0')}-${String(p.paidOn.day||1).padStart(2,'0')}`:new Date(p.timestamp).toISOString().slice(0,10),
      name: p.studentName||batchStudents?.[p.studentId]?.name||'Student',
      sub:  batches?.[p.batchId]?.name||'Standalone',
      type: p.type||'full', months:p.monthsPaid||1, amt:p.amount||0,
      ts: p.timestamp, paidOn: p.paidOn, batchId: p.batchId||null,
    }));
  }

  if (_histPeriod === 'this') {
    allPays = allPays.filter(p => {
      const d = p.paidOn ? new Date(p.paidOn.year,(p.paidOn.month||1)-1,1) : new Date(p.ts);
      return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    });
  } else if (_histPeriod === 'prev') {
    const pm = now.getMonth()-1<0?11:now.getMonth()-1;
    const py = now.getMonth()-1<0?now.getFullYear()-1:now.getFullYear();
    allPays = allPays.filter(p => {
      const d = p.paidOn ? new Date(p.paidOn.year,(p.paidOn.month||1)-1,1) : new Date(p.ts);
      return d.getMonth()===pm && d.getFullYear()===py;
    });
  }
  if (isT() && _histBatch !== 'all') {
    allPays = allPays.filter(p => _histBatch==='standalone' ? !p.batchId : p.batchId===_histBatch);
  }
  if (_histFilter !== 'all') allPays = allPays.filter(p => p.type===_histFilter);
  allPays.sort((a,b)=>b.date.localeCompare(a.date));

  if (!allPays.length) { toast('No data to export','error'); return; }

  if (typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.book_new();
    const title = isT() ? 'Fee Tracker — Collections' : 'Fee Tracker — Payments';
    const subTitle = `Exported: ${now.toLocaleDateString(USER_LOCALE,{day:'numeric',month:'long',year:'numeric'})}`;
    const headers = isT()
      ? ['Date','Student','Batch','Type','Months','Amount (₹)']
      : ['Date','Teacher','Subject','Type','Months','Amount (₹)'];

    const aoa = [
      [title],
      [subTitle],
      [],
      headers,
      ...allPays.map(p => [p.date, p.name, p.sub, p.type.charAt(0).toUpperCase()+p.type.slice(1), p.months, p.amt]),
      [],
      ['', '', '', '', 'TOTAL', allPays.reduce((s,p)=>s+p.amt,0)],
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    ws['!cols'] = [{wch:12},{wch:22},{wch:22},{wch:10},{wch:8},{wch:14}];

    ws['!merges'] = [
      {s:{r:0,c:0},e:{r:0,c:5}},
      {s:{r:1,c:0},e:{r:1,c:5}},
    ];

    const titleStyle  = {font:{bold:true,sz:14,color:{rgb:'7C6BFF'}},alignment:{horizontal:'left'},fill:{fgColor:{rgb:'0D0D1F'}}};
    const subStyle    = {font:{sz:10,color:{rgb:'8A8AB5'}},fill:{fgColor:{rgb:'0D0D1F'}}};
    const headerStyle = {font:{bold:true,sz:11,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'4A35E0'}},alignment:{horizontal:'center'},border:{bottom:{style:'medium',color:{rgb:'7C6BFF'}}}};
    const rowEven     = {fill:{fgColor:{rgb:'13132B'}},font:{sz:10,color:{rgb:'EEEEF8'}}};
    const rowOdd      = {fill:{fgColor:{rgb:'0D0D1F'}},font:{sz:10,color:{rgb:'EEEEF8'}}};
    const amtStyle    = {font:{bold:true,sz:10,color:{rgb:'00D4AA'}},numFmt:'#,##0'};
    const totalStyle  = {font:{bold:true,sz:11,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'7C6BFF'}},numFmt:'#,##0'};
    const totalLblSty = {font:{bold:true,sz:11,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'7C6BFF'}}};

    const setCellStyle = (r,c,sty) => {
      const addr = XLSX.utils.encode_cell({r,c});
      if (!ws[addr]) ws[addr] = {v:''};
      ws[addr].s = sty;
    };

    for(let c=0;c<=5;c++) setCellStyle(0,c,titleStyle);
    for(let c=0;c<=5;c++) setCellStyle(1,c,subStyle);

    headers.forEach((_,c) => setCellStyle(3,c,headerStyle));

    const typeColors = {full:'00D4AA',partial:'FF9A3C',advance:'7C6BFF'};
    allPays.forEach((p,i) => {
      const r = 4+i;
      const base = i%2===0?rowEven:rowOdd;
      for(let c=0;c<=5;c++){
        const addr = XLSX.utils.encode_cell({r,c});
        if(!ws[addr]) ws[addr]={v:''};
        if(c===3){
          ws[addr].s={...base,font:{...base.font,bold:true,color:{rgb:typeColors[p.type]||'EEEEF8'}}};
        } else if(c===5){
          ws[addr].s={...amtStyle,fill:base.fill};
          ws[addr].t='n';
        } else {
          ws[addr].s=base;
        }
      }
    });

    const totalR = 4+allPays.length+1;
    for(let c=0;c<=5;c++) setCellStyle(totalR,c,c===4||c===5?totalStyle:totalLblSty);
    const totalAmtAddr = XLSX.utils.encode_cell({r:totalR,c:5});
    if(ws[totalAmtAddr]) ws[totalAmtAddr].t='n';

    XLSX.utils.book_append_sheet(wb, ws, 'Payments');

    const periodLabel = _histPeriod==='this'?`-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`:_histPeriod==='prev'?`-prev-month`:'';
    const batchLabel  = isT()&&_histBatch!=='all'?`-${(batches[_histBatch]?.name||'standalone').replace(/\s+/g,'-')}`:'';
    const fname = `fee-history${periodLabel}${batchLabel}.xlsx`;
    XLSX.writeFile(wb, fname);
    toast('Excel file exported', 'success');

  } else {
    
    const headers = isT()?'Date,Student,Batch,Type,Months,Amount':'Date,Teacher,Subject,Type,Months,Amount';
    const rows = [headers, ...allPays.map(p=>[p.date,`"${p.name}"`,`"${p.sub}"`,p.type,p.months,p.amt].join(','))];
    const blob = new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8;'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=`payments-${now.getFullYear()}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('CSV exported (install app for Excel)','success');
  }
};
