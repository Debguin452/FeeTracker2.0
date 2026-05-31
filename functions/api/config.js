export async function onRequest({ env, request }) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ['https://feetracker2.pages.dev', 'https://feetracker.pages.dev'];
  const corsOrigin = allowed.includes(origin) ? origin : (origin === '' ? '*' : 'null');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }});
  }

  const required = ['FB1_API_KEY','FB1_PROJECT_ID','FB1_MESSAGING_SENDER_ID','FB1_APP_ID','RECAPTCHA_SITE_KEY','FCM_VAPID_KEY'];
  const missing = required.filter(k => !env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration', missing }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': corsOrigin }
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

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      'Access-Control-Allow-Origin': corsOrigin,
      'Vary': 'Origin',
    }
  });
}
