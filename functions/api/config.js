// ── /api/config ────────────────────────────────────────────────────────────
// Serves the Firebase client config to the front-end.
// All secrets come from Cloudflare Pages environment variables — nothing is
// hardcoded here.
//
// To switch domains: update the ALLOWED_ORIGINS list below.
// Test  → https://feetracker2.pages.dev
// Prod  → https://feetracker.pages.dev

const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',   // test
  'https://feetracker.pages.dev',    // production (add when ready)
];

function corsOrigin(requestOrigin) {
  if (!requestOrigin)                          return null; // same-origin fetch, no CORS needed
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null; // reject
}

export async function onRequest({ env, request }) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowed   = corsOrigin(reqOrigin);

  // Block cross-origin requests from unlisted domains
  if (reqOrigin && !allowed) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const corsHeaders = allowed ? {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  } : {};

  // ── Preflight ────────────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
  }

  // ── Check all required secrets are present ───────────────────────────────
  const required = [
    'FB1_API_KEY', 'FB1_PROJECT_ID', 'FB1_MESSAGING_SENDER_ID',
    'FB1_APP_ID',  'RECAPTCHA_SITE_KEY', 'FCM_VAPID_KEY',
  ];
  const missing = required.filter(k => !env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration', missing }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }

  // ── authDomain is always the hostname serving this request ───────────────
  // This makes the /__/auth proxy work on any domain without code changes:
  //   feetracker2.pages.dev  →  authDomain = feetracker2.pages.dev
  //   feetracker.pages.dev   →  authDomain = feetracker.pages.dev
  const authDomain = new URL(request.url).hostname;

  const config = {
    firebase: {
      primary: {
        apiKey:            env.FB1_API_KEY,
        authDomain,
        projectId:         env.FB1_PROJECT_ID,
        storageBucket:     `${env.FB1_PROJECT_ID}.firebasestorage.app`,
        messagingSenderId: env.FB1_MESSAGING_SENDER_ID,
        appId:             env.FB1_APP_ID,
      },
    },
    recaptchaSiteKey: env.RECAPTCHA_SITE_KEY,
    vapidKey:         env.FCM_VAPID_KEY,
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      ...corsHeaders,
    },
  });
}
