export async function onRequest(context) {
  const { request, params, env } = context;

  const projectId = env.FB1_PROJECT_ID;
  if (!projectId) {
    return new Response('Auth proxy misconfigured: FB1_PROJECT_ID secret not set.', { status: 500 });
  }

  const firebaseAuthDomain = `${projectId}.firebaseapp.com`;
  const url = new URL(request.url);
  const pathSegments = params.path;
  const upstreamPath = `/__/auth/${Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments}`;
  const upstreamUrl  = `https://${firebaseAuthDomain}${upstreamPath}${url.search}`;

  // Build clean headers — do NOT set Host (Cloudflare blocks custom Host on outbound fetches)
  const proxyHeaders = new Headers();
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    // Strip Cloudflare-injected and hop-by-hop headers
    if (['host','cf-connecting-ip','cf-ray','cf-visitor','cf-ipcountry',
         'cf-worker','cdn-loop','x-forwarded-proto','x-forwarded-for',
         'connection','keep-alive','transfer-encoding','te','upgrade'].includes(lower)) continue;
    proxyHeaders.set(k, v);
  }
  // Tell Firebase the real origin so it can validate the redirect
  proxyHeaders.set('Origin', `https://${firebaseAuthDomain}`);
  proxyHeaders.set('Referer', `https://${firebaseAuthDomain}/`);

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

  const responseHeaders = new Headers();
  for (const [k, v] of upstreamResponse.headers.entries()) {
    const lower = k.toLowerCase();
    // Strip headers that would block the iframe or cause issues
    if (['content-security-policy','x-frame-options','alt-svc',
         'connection','keep-alive','transfer-encoding'].includes(lower)) continue;
    responseHeaders.set(k, v);
  }
  responseHeaders.set('X-Content-Type-Options', 'nosniff');

  const contentType = responseHeaders.get('Content-Type') || '';
  if (contentType.includes('text/html') || contentType.includes('javascript')) {
    const body = await upstreamResponse.text();
    // Rewrite any absolute Firebase auth domain references to our custom domain
    const rewritten = body
      .replaceAll(`https://${firebaseAuthDomain}`, url.origin)
      .replaceAll(`//${firebaseAuthDomain}`, `//${url.hostname}`);
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
