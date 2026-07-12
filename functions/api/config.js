const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',
  'https://feetracker.pages.dev',
];

function corsOrigin(requestOrigin) {
  if (!requestOrigin) return null;
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null;
}

export async function onRequest({ env, request }) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowed   = corsOrigin(reqOrigin);

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

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
  }

  const required = [
    'FB1_API_KEY', 'FB1_PROJECT_ID', 'FB1_MESSAGING_SENDER_ID',
    'FB1_APP_ID',  'FCM_VAPID_KEY',
  ];
  const missing = required.filter(k => !env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }

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
    vapidKey: env.FCM_VAPID_KEY,
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}
