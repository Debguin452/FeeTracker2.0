// Auth proxy — tunnels Firebase's auth UI through the custom Pages domain.
//
// STATUS: ACTIVE. /api/config sets authDomain to this Pages domain, so the
// Firebase SDK navigates here for /__/auth/* during sign-in and this file
// runs on every request.
//
// REQUIRES, or Google sign-in fails with redirect_uri_mismatch:
//   Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client
//   ID "Web client (auto created by Google Service)" for this Firebase
//   project → Authorized redirect URIs → add:
//     https://<this-pages-domain>/__/auth/handler
//   (Firebase Console → Authentication → Authorized domains is a DIFFERENT
//   list — it authorizes initiating sign-in, it does not register this
//   redirect URI with Google. Both are required.)
//
// Test both signInWithPopup (desktop) and signInWithRedirect (the mobile
// fallback in sign.html/app.js) end-to-end — redirect is the path that
// actually round-trips through this proxy and is most likely to break.
//
// Required secret: FB1_PROJECT_ID

export async function onRequest(context) {
  const { request, params, env } = context;
  const url = new URL(request.url);

  // ── CORS preflight ─────────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  url.origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Version, X-Firebase-gmpid',
        'Access-Control-Max-Age':       '86400',
        'Vary': 'Origin',
      },
    });
  }

  const projectId = env.FB1_PROJECT_ID;
  if (!projectId) {
    return new Response('Auth proxy misconfigured: FB1_PROJECT_ID secret not set.', { status: 500 });
  }

  const firebaseAuthDomain = `${projectId}.firebaseapp.com`;

  // Build upstream path from catch-all params
  const pathSegments = params.path;
  const upstreamPath = `/__/auth/${Array.isArray(pathSegments) ? pathSegments.join('/') : (pathSegments || '')}`;
  const upstreamUrl  = `https://${firebaseAuthDomain}${upstreamPath}${url.search}`;

  // Forward headers — fix Host, strip Cloudflare-injected headers
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Host', firebaseAuthDomain);
  proxyHeaders.delete('CF-Connecting-IP');
  proxyHeaders.delete('CF-Ray');
  proxyHeaders.delete('CF-Visitor');
  proxyHeaders.delete('X-Forwarded-For');

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method:   request.method,
      headers:  proxyHeaders,
      body:     (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Auth proxy fetch error: ${err.message}`, { status: 502 });
  }

  const rh = new Headers(upstream.headers);

  // ── Strip headers that break Firebase's auth mechanism ─────────────────────
  rh.delete('X-Frame-Options');
  rh.delete('Content-Security-Policy');
  rh.delete('Content-Security-Policy-Report-Only');
  rh.delete('Cross-Origin-Opener-Policy');
  rh.delete('Cross-Origin-Embedder-Policy');
  rh.delete('X-Content-Type-Options');

  // ── CORS: reflect the request Origin (credentials-safe) ────────────────────
  const reqOrigin = request.headers.get('Origin');
  if (reqOrigin) {
    rh.set('Access-Control-Allow-Origin',      reqOrigin);
    rh.set('Access-Control-Allow-Credentials', 'true');
    rh.set('Vary', 'Origin');
  }

  const contentType = rh.get('Content-Type') || '';

  // ── Domain rewrite for HTML/JS responses ───────────────────────────────────
  if (contentType.includes('text/html') || contentType.includes('javascript')) {
    const body      = await upstream.text();
    const rewritten = body
      .replaceAll(`https://${firebaseAuthDomain}`, url.origin)
      .replaceAll(`//${firebaseAuthDomain}`,        `//${url.hostname}`);
    return new Response(rewritten, { status: upstream.status, headers: rh });
  }

  return new Response(upstream.body, { status: upstream.status, headers: rh });
}
