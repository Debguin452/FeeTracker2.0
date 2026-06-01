// Auth proxy — mirrors the production proxy exactly.
// Reads FB1_PROJECT_ID from Cloudflare secret so no API keys are hardcoded.
// authDomain in /api/config is set to this Pages domain (feetracker2.pages.dev)
// so Firebase SDK routes all /__/auth/* calls through here to Firebase's auth servers.

export async function onRequest(context) {
  const { request, params, env } = context;

  const projectId = env.FB1_PROJECT_ID;
  if (!projectId) {
    return new Response('Auth proxy misconfigured: FB1_PROJECT_ID secret not set.', { status: 500 });
  }

  const firebaseAuthDomain = `${projectId}.firebaseapp.com`;
  const url                = new URL(request.url);
  const pathSegments       = params.path;
  const upstreamPath       = `/__/auth/${Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments}`;
  const upstreamUrl        = `https://${firebaseAuthDomain}${upstreamPath}${url.search}`;

  // Copy all request headers, set correct Host, remove Cloudflare-injected IP header
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Host', firebaseAuthDomain);
  proxyHeaders.delete('CF-Connecting-IP');

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method:  request.method,
      headers: proxyHeaders,
      body:    request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Auth proxy error: ${err.message}`, { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  // Remove headers that would break the auth flow in the browser
  responseHeaders.delete('Content-Security-Policy');
  responseHeaders.delete('X-Frame-Options');

  const contentType = responseHeaders.get('Content-Type') || '';
  if (contentType.includes('text/html') || contentType.includes('javascript')) {
    const body = await upstreamResponse.text();
    // Rewrite all references from Firebase's domain back to our custom domain
    const rewritten = body
      .replaceAll(`https://${firebaseAuthDomain}`, url.origin)
      .replaceAll(`//${firebaseAuthDomain}`,       `//${url.hostname}`);
    return new Response(rewritten, {
      status:  upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status:  upstreamResponse.status,
    headers: responseHeaders,
  });
}
