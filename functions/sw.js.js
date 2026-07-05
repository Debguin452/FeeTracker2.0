// Serves /sw.js dynamically instead of as a static file, so the cache
// version can be stamped in automatically on every deploy — no more manual
// "bump v15 -> v16" edits.
//
// CF_PAGES_COMMIT_SHA is injected by Cloudflare Pages on every build with no
// setup required (docs: https://developers.cloudflare.com/pages/functions/bindings/#environment-variables).
// It changes on every single deploy, which is exactly what we want: a new
// commit = a new CACHE_VERSION = a new cache namespace = every returning
// user's service worker cleans up old caches and re-fetches everything
// fresh, automatically, forever.
//
// The actual service worker logic still lives in the plain /sw.js file at
// the repo root — this function fetches that file via the ASSETS binding
// (bypasses Pages' own routing, goes straight to the static asset store, so
// there's no recursion) and replaces the __CACHE_VERSION__ placeholder in it
// before responding.
//
// Filename note: Cloudflare Pages Functions strip the file extension when
// mapping to a route (functions/api/hello.js -> /api/hello), so to own the
// literal /sw.js path the file must be named sw.js.js — the first .js is
// part of the route, the second is the Function's own extension.

export async function onRequest(context) {
  const { request, env } = context;

  const templateUrl = new URL('/sw.js', request.url);
  const templateRes = await env.ASSETS.fetch(new Request(templateUrl, request));

  if (!templateRes.ok) {
    return new Response('// sw.js template not found', { status: 500 });
  }

  const template = await templateRes.text();
  const version  = (env.CF_PAGES_COMMIT_SHA || String(Date.now())).slice(0, 10);
  const body     = template.replaceAll('__CACHE_VERSION__', version);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Service workers must never be cached long-term — browsers already
      // re-check the SW script periodically, but an explicit no-cache here
      // guarantees this dynamic response is never stale.
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  });
}
