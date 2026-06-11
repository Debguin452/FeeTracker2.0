if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js?v=13');

      navigator.serviceWorker.addEventListener('message', e => {
        const { type, version } = e.data || {};
        switch (type) {
          case 'SW_ACTIVATED':
            if (version) setTimeout(() => { if (typeof window.toast === 'function') window.toast('App updated ✓', 'success'); }, 800);
            break;
          case 'BG_SYNC_TRIGGER':
            if (typeof window.loadAll === 'function' && window._cooldown('swSync', 30000)) window.loadAll(true);
            break;
          case 'REPLAY_QUEUE':
            if (typeof window.loadAll === 'function' && window._cooldown('swReplay', 30000)) window.loadAll(true);
            break;
          case 'PERIODIC_REMINDER_CHECK':
            if (typeof window._checkDueReminder === 'function') window._checkDueReminder();
            break;
          case 'NOTIFICATION_CLICK':
            window.focus();
            break;
        }
      });

      if ('periodicSync' in reg) {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await reg.periodicSync.register('fee-reminder-check', { minInterval: 24 * 60 * 60 * 1000 }).catch(() => {});
        }
      }

      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });

      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            newSW.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

    } catch {}
  });

  window._clearSWCache = () => {
    const uid = typeof window.getCacheUid === 'function' ? window.getCacheUid() : null;
    const sw  = navigator.serviceWorker.controller;
    if (sw) {
      sw.postMessage({ type: 'CLEAR_CACHE' });
      if (uid && uid !== 'anon') sw.postMessage({ type: 'PURGE_QUEUE', uid });
    }
  };
}

let deferredInstallPrompt = null;

const _isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function setMenuInstallVisible(show) {
  const btn              = document.getElementById('menuInstallBtn');
  const alreadyInstalled = _isStandalone || localStorage.getItem('ftPWAInstalled') === '1';
  if (btn) btn.classList.toggle('hidden', !show || alreadyInstalled);
}

if (_isStandalone || localStorage.getItem('ftPWAInstalled') === '1') {
  document.getElementById('installBanner')?.remove();
  document.getElementById('pwaBanner')?.remove();
  document.getElementById('menuInstallBtn')?.remove();
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  if (_isStandalone || localStorage.getItem('ftPWAInstalled') === '1') return;
  deferredInstallPrompt = e;
  setMenuInstallVisible(true);
  if (!localStorage.getItem('ftInstallDismissed')) setTimeout(showInstallBanner, 3000);
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('menuInstallBtn')?.addEventListener('click', async () => {
    document.getElementById('userMenu')?.classList.add('hidden');
    document.getElementById('menuBackdrop')?.classList.add('hidden');
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === 'accepted') {
        setMenuInstallVisible(false);
        localStorage.setItem('ftInstallDismissed', '1');
      }
    }
  });
});

function showInstallBanner() {
  document.getElementById('installBanner')?.classList.add('show');
}

function hideInstallBanner() {
  document.getElementById('installBanner')?.classList.remove('show');
}

document.getElementById('installSkipBtn')?.addEventListener('click', () => {
  hideInstallBanner();
  localStorage.setItem('ftInstallDismissed', '1');
});

document.getElementById('installAddBtn')?.addEventListener('click', async () => {
  hideInstallBanner();
  localStorage.setItem('ftInstallDismissed', '1');
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  }
});

window.addEventListener('appinstalled', () => {
  localStorage.setItem('ftInstallDismissed', '1');
  localStorage.setItem('ftPWAInstalled', '1');
  hideInstallBanner();
  setMenuInstallVisible(false);
  deferredInstallPrompt = null;
});

function _loginOffline() {
  const n = document.getElementById('loginOfflineNotice');
  if (n) n.style.display = navigator.onLine ? 'none' : 'flex';
}
window.addEventListener('online',  _loginOffline);
window.addEventListener('offline', _loginOffline);
_loginOffline();
