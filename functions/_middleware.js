// ── Cloudflare Pages middleware ────────────────────────────────────────────
// Runs on every request before the specific function handler.
// Responsibilities:
//   1. Pass /__/auth/* straight through (no modifications — Firebase auth proxy)
//   2. Skip security headers for static assets
//   3. Rate-limit all other routes
//   4. Enforce origin lock on /api/* routes
//   5. Add security headers to all responses

// ── Rate limits ────────────────────────────────────────────────────────────
const RL_WINDOW_MS   = 60_000;
const RL_GLOBAL      = 120;
const RL_AUTH        = 30;
const RL_CONFIG      = 20;

// ── Allowed origins (same list as api/config.js) ───────────────────────────
// Swap feetracker2 → feetracker when going to production.
const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',
  'https://feetracker.pages.dev',
];

function getClientKey(request) {
  const ip  = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const url = new URL(request.url);
  const bucket = url.pathname.startsWith('/__/auth')   ? 'auth'
               : url.pathname.startsWith('/api/config') ? 'cfg'
               : 'global';
  return `rl:${ip}:${bucket}`;
}

function getLimit(pathname) {
  if (pathname.startsWith('/__/auth'))    return RL_AUTH;
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

  // ── 1. Auth proxy — must pass completely untouched ─────────────────────
  // Any header added here (X-Frame-Options, CSP, etc.) would break the
  // Firebase SDK's iframe session manager and kill sign-in.
  if (url.pathname.startsWith('/__/auth')) {
    return next();
  }

  // ── 2. Static assets — skip rate-limit & security headers ──────────────
  const isStatic =
    url.pathname.startsWith('/icons/')    ||
    url.pathname.startsWith('/css/')      ||
    url.pathname.startsWith('/js/')       ||
    url.pathname === '/manifest.json'     ||
    url.pathname === '/sw.js'             ||
    url.pathname === '/robots.txt'        ||
    url.pathname === '/sitemap.xml';

  if (isStatic) return next();

  // ── 3. Origin lock for /api/* routes ───────────────────────────────────
  // Block cross-origin requests from domains not in ALLOWED_ORIGINS.
  // Same-origin fetches (no Origin header) are always allowed.
  if (url.pathname.startsWith('/api/')) {
    const reqOrigin = request.headers.get('Origin');
    if (reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin)) {
      return new Response(JSON.stringify({ error: 'Unauthorized origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }

  // ── 4. Rate limiting ────────────────────────────────────────────────────
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
      },
    });
  }

  // ── 5. Security headers ─────────────────────────────────────────────────
  const response   = await next();
  const secHeaders = new Headers(response.headers);

  secHeaders.set('X-Content-Type-Options',  'nosniff');
  secHeaders.set('X-Frame-Options',         'DENY');
  secHeaders.set('Referrer-Policy',         'strict-origin-when-cross-origin');
  secHeaders.set('Permissions-Policy',      'geolocation=(), microphone=(), camera=()');

  if (url.pathname.startsWith('/api/')) {
    secHeaders.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers:    secHeaders,
  });
}
