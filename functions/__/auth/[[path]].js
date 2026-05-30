const FIREBASE_PROJECT_ID = "fee-tracker-f32f8";
const FIREBASE_AUTH_DOMAIN = `${FIREBASE_PROJECT_ID}.firebaseapp.com`;

export async function onRequest(context) {
  const { request, params } = context;

  const url = new URL(request.url);
  const pathSegments = params.path;
  const upstreamPath  = `/__/auth/${Array.isArray(pathSegments) ? pathSegments.join("/") : pathSegments}`;
  const upstreamUrl   = `https://${FIREBASE_AUTH_DOMAIN}${upstreamPath}${url.search}`;

  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set("Host", FIREBASE_AUTH_DOMAIN);
  proxyHeaders.delete("CF-Connecting-IP");

  const upstreamRequest = new Request(upstreamUrl, {
    method:  request.method,
    headers: proxyHeaders,
    body:    request.method !== "GET" && request.method !== "HEAD"
               ? request.body
               : undefined,
    redirect: "follow",
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("Content-Security-Policy");
  responseHeaders.delete("X-Frame-Options");

  const contentType = responseHeaders.get("Content-Type") || "";
  if (contentType.includes("text/html") || contentType.includes("javascript")) {
    const body = await upstreamResponse.text();
    const rewrittenBody = body
      .replaceAll(`https://${FIREBASE_AUTH_DOMAIN}`, url.origin)
      .replaceAll(`//${FIREBASE_AUTH_DOMAIN}`,       `//${url.hostname}`);
    return new Response(rewrittenBody, {
      status:  upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status:  upstreamResponse.status,
    headers: responseHeaders,
  });
}
