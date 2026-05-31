export async function onRequest({ request, params, env }) {
  const projectId = env.FB1_PROJECT_ID;
  if (!projectId) return new Response('Auth proxy misconfigured: FB1_PROJECT_ID not set.', { status: 500 });

  const authDomain = `${projectId}.firebaseapp.com`;
  const url = new URL(request.url);
  const upstreamPath = `/__/auth/${Array.isArray(params.path) ? params.path.join('/') : params.path}`;
  const upstreamUrl = `https://${authDomain}${upstreamPath}${url.search}`;

  const proxyHeaders = new Headers();
  for (const [k, v] of request.headers.entries()) {
    const l = k.toLowerCase();
    if (['host','cf-connecting-ip','cf-ray','cf-visitor','cf-ipcountry','cf-worker',
         'cdn-loop','x-forwarded-proto','x-forwarded-for','connection','keep-alive',
         'transfer-encoding','te','upgrade'].includes(l)) continue;
    proxyHeaders.set(k, v);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Auth proxy error: ${err.message}`, { status: 502 });
  }

  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const l = k.toLowerCase();
    if (['content-security-policy','x-frame-options','alt-svc','connection','keep-alive','transfer-encoding'].includes(l)) continue;
    resHeaders.set(k, v);
  }
  resHeaders.set('X-Content-Type-Options', 'nosniff');

  const ct = resHeaders.get('Content-Type') || '';
  if (ct.includes('text/html') || ct.includes('javascript')) {
    const body = await upstream.text();
    return new Response(
      body.replaceAll(`https://${authDomain}`, url.origin).replaceAll(`//${authDomain}`, `//${url.hostname}`),
      { status: upstream.status, headers: resHeaders }
    );
  }

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
