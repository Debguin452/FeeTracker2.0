const RL_WINDOW_MS = 60_000;
const RL_GLOBAL    = 120;
const RL_AUTH      = 30;
const RL_CONFIG    = 20;

const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',
  'https://feetracker.pages.dev',
];

function getClientKey(request) {
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const url = new URL(request.url);
  const bucket = url.pathname.startsWith('/__/auth')    ? 'auth'
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

  // Auth proxy — pass untouched; adding headers here breaks Firebase's iframe/popup flow
  if (url.pathname.startsWith('/__/auth')) {
    return next();
  }

  // Static assets — skip rate-limit and security headers
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

  if (url.pathname.startsWith('/api/')) {
    secHeaders.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers:    secHeaders,
  });
}
