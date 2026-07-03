// Serves Firebase client config + Turnstile VAPID key to the front-end.
// All secrets come from Cloudflare Pages environment variables — nothing is hardcoded.

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

  // authDomain = the Pages domain that served this request, so the sign-in UI
  // stays on feetracker2.pages.dev instead of redirecting to firebaseapp.com.
  // functions/__/auth/[[path]].js proxies + rewrites Firebase's auth handler
  // to make this work.
  //
  // REQUIRED one-time setup or Google sign-in will fail with
  // redirect_uri_mismatch:
  //   Google Cloud Console → APIs & Services → Credentials → find the
  //   OAuth 2.0 Client ID Firebase auto-created for this project (named
  //   "Web client (auto created by Google Service)") → Authorized redirect
  //   URIs → add:
  //     https://feetracker2.pages.dev/__/auth/handler
  //     https://feetracker.pages.dev/__/auth/handler   (if still used)
  //   (Firebase Console → Authentication → Authorized domains only
  //   authorizes *initiating* sign-in from a domain — it does NOT add the
  //   redirect URI to the Google OAuth client. That's a separate step in a
  //   separate console, easy to miss, and is what broke this before.)
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
    vapidKey:         env.FCM_VAPID_KEY,
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      // No caching — Firebase config + site keys must not be cached by CDN or browser
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}
