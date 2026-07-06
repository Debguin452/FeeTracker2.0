const RL_WINDOW_MS = 60_000;
const RL_GLOBAL    = 120;
const RL_CONFIG    = 20;

const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',
  'https://feetracker.pages.dev',
];

function getClientKey(request) {
  // CF-Connecting-IP is set by Cloudflare's edge on every request that
  // reaches Pages/Workers and cannot be spoofed by the client. The previous
  // X-Forwarded-For fallback is a plain client-supplied header — an
  // attacker could set it to anything, giving themselves a fresh rate-limit
  // bucket on every request and defeating the limiter entirely. If
  // CF-Connecting-IP is ever genuinely absent, everyone shares the
  // 'unknown' bucket (overly strict, not exploitable) rather than trusting
  // an attacker-controlled value.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(request.url);
  const bucket = url.pathname.startsWith('/api/config') ? 'cfg' : 'global';
  return `rl:${ip}:${bucket}`;
}

function getLimit(pathname) {
  if (pathname.startsWith('/api/config')) return RL_CONFIG;
  return RL_GLOBAL;
}

async function checkRateLimit(env, key, limit) {
  if (!env.RATE_LIMIT_KV) return { allowed: true };
  const now       = Date.now();
  const windowKey = `${key}:${Math.floor(now / RL_WINDOW_MS)}`;
  const raw       = await env.RATE_LIMIT_KV.get(windowKey);
  const count     = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return { allowed: false };
  await env.RATE_LIMIT_KV.put(windowKey, String(count + 1), { expirationTtl: 120 });
  return { allowed: true };
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const isStatic =
    url.pathname.startsWith('/icons/')  ||
    url.pathname.startsWith('/css/')    ||
    url.pathname.startsWith('/js/')     ||
    url.pathname === '/manifest.json'   ||
    url.pathname === '/sw.js'           ||
    url.pathname === '/robots.txt'      ||
    url.pathname === '/sitemap.xml';

  if (isStatic) return next();

  // Origin lock for /api/* routes
  if (url.pathname.startsWith('/api/')) {
    const reqOrigin = request.headers.get('Origin');
    if (reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin)) {
      return new Response(JSON.stringify({ error: 'Unauthorized origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }

  // Rate limiting
  const { allowed } = await checkRateLimit(
    env,
    getClientKey(request),
    getLimit(url.pathname),
  );

  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Too Many Requests', retryAfter: 60 }), {
      status: 429,
      headers: {
        'Content-Type':       'application/json',
        'Retry-After':        '60',
        'X-RateLimit-Limit':  String(getLimit(url.pathname)),
        'X-RateLimit-Window': '60',
        'Cache-Control':      'no-store',
      },
    });
  }

  // Security headers on all non-static responses
  const response   = await next();
  const secHeaders = new Headers(response.headers);

  secHeaders.set('X-Content-Type-Options', 'nosniff');
  secHeaders.set('X-Frame-Options',        'DENY');
  secHeaders.set('Referrer-Policy',        'strict-origin-when-cross-origin');
  secHeaders.set('Permissions-Policy',     'geolocation=(), microphone=(), camera=()');

  // Content-Security-Policy — Report-Only for now, deliberately.
  // This app relies on ~100+ inline onclick="..." handlers and inline
  // <style> blocks throughout app.html/sign.html/connect.html (a direct
  // consequence of app.js being a `type="module"` script, which doesn't
  // leak function names to the global scope inline handlers need — see
  // the window.X = ... bridging pattern noted elsewhere in this file).
  // An ENFORCED CSP without 'unsafe-inline' on script-src would break
  // every one of those handlers immediately. Report-Only logs violations
  // to the console without blocking anything, so this can be verified
  // safe first. To switch to enforced: rename this header to
  // 'Content-Security-Policy', then open the app with devtools console
  // open and click through sign-in (Google + email), the dashboard, and
  // recording a payment — zero CSP violation messages means it's safe to
  // switch. Removing 'unsafe-inline' entirely requires migrating the
  // inline onclick handlers to addEventListener first (a separate,
  // larger refactor — don't attempt both changes at once).
  secHeaders.set('Content-Security-Policy-Report-Only', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://cdnjs.cloudflare.com https://challenges.cloudflare.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://firebasestorage.googleapis.com https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com https://accounts.google.com https://*.firebaseapp.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
  ].join('; '));

  if (url.pathname.startsWith('/api/')) {
    secHeaders.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers:    secHeaders,
  });
}
