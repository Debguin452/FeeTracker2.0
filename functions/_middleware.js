const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const AUTH_MAX_REQUESTS = 30;
const CONFIG_MAX_REQUESTS = 20;

function getClientKey(request) {
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const url = new URL(request.url);
  return `rl:${ip}:${url.pathname.startsWith('/__/auth') ? 'auth' : url.pathname.startsWith('/api/config') ? 'cfg' : 'global'}`;
}

function getLimit(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__/auth')) return AUTH_MAX_REQUESTS;
  if (url.pathname.startsWith('/api/config')) return CONFIG_MAX_REQUESTS;
  return MAX_REQUESTS_PER_WINDOW;
}

async function checkRateLimit(env, key, limit) {
  if (!env.RATE_LIMIT_KV) return { allowed: true };
  const now = Date.now();
  const windowKey = `${key}:${Math.floor(now / RATE_LIMIT_WINDOW_MS)}`;
  const raw = await env.RATE_LIMIT_KV.get(windowKey);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return { allowed: false, count };
  await env.RATE_LIMIT_KV.put(windowKey, String(count + 1), { expirationTtl: 120 });
  return { allowed: true, count: count + 1 };
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/css/') ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/sw.js' ||
    url.pathname === '/sitemap.xml' ||
    url.pathname === '/robots.txt'
  ) {
    return next();
  }

  const key   = getClientKey(request);
  const limit = getLimit(request);
  const { allowed } = await checkRateLimit(env, key, limit);

  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Too Many Requests', retryAfter: 60 }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Window': '60',
      },
    });
  }

  const response = await next();

  const secHeaders = new Headers(response.headers);
  secHeaders.set('X-Content-Type-Options', 'nosniff');

  // /__/auth/* is used by Firebase Auth popup — it loads inside an iframe.
  // Setting X-Frame-Options: DENY there breaks Google Sign-In entirely.
  // All other pages use SAMEORIGIN (prevents third-party framing but allows
  // Firebase's own same-origin iframe handshake).
  if (url.pathname.startsWith('/__/auth')) {
    secHeaders.delete('X-Frame-Options');
  } else {
    secHeaders.set('X-Frame-Options', 'SAMEORIGIN');
  }

  secHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  secHeaders.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (url.pathname.startsWith('/api/')) {
    secHeaders.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: secHeaders,
  });
}
