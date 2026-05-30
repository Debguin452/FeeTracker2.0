const CACHE_MAX_AGE = 300;

export async function onRequest(context) {
  const { env, request } = context;

  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://feetracker2.pages.dev',
    'https://feetracker.pages.dev',
    'https://fee.tracker1.workers.dev',
  ];
  const originAllowed = allowedOrigins.includes(origin) || origin === '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': originAllowed ? origin : 'null',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const required = [
    'FB1_API_KEY', 'FB1_PROJECT_ID', 'FB1_MESSAGING_SENDER_ID', 'FB1_APP_ID',
    'FB2_API_KEY', 'FB2_PROJECT_ID', 'FB2_MESSAGING_SENDER_ID', 'FB2_APP_ID',
    'RECAPTCHA_SITE_KEY', 'FCM_VAPID_KEY',
  ];

  const missing = required.filter(k => !env[k]);
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration', missing }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const config = {
    firebase: {
      primary: {
        apiKey:            env.FB1_API_KEY,
        authDomain:        'feetracker2.pages.dev',
        projectId:         env.FB1_PROJECT_ID,
        storageBucket:     `${env.FB1_PROJECT_ID}.firebasestorage.app`,
        messagingSenderId: env.FB1_MESSAGING_SENDER_ID,
        appId:             env.FB1_APP_ID,
      },
      secondary: env.FB2_API_KEY ? {
        apiKey:            env.FB2_API_KEY,
        authDomain:        'feetracker2.pages.dev',
        projectId:         env.FB2_PROJECT_ID,
        storageBucket:     `${env.FB2_PROJECT_ID}.firebasestorage.app`,
        messagingSenderId: env.FB2_MESSAGING_SENDER_ID,
        appId:             env.FB2_APP_ID,
      } : null,
    },
    recaptchaSiteKey: env.RECAPTCHA_SITE_KEY,
    vapidKey:         env.FCM_VAPID_KEY,
  };

  const corsOrigin = originAllowed ? (origin || '*') : 'null';

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=60`,
      'Access-Control-Allow-Origin': corsOrigin,
      'Vary': 'Origin',
    },
  });
}
