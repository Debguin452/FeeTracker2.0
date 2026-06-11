// Cloudflare Turnstile server-side verification
// Required env secret: TURNSTILE_SECRET
// Add it in: Cloudflare Pages → Settings → Environment Variables

const ALLOWED_ORIGINS = [
  'https://feetracker2.pages.dev',
  'https://feetracker.pages.dev',
];

function corsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

export async function onRequestPost({ env, request }) {
  const corsH = corsHeaders(request.headers.get('Origin') || '');

  if (!env.TURNSTILE_SECRET) {
    return new Response(JSON.stringify({ success: false, error: 'Turnstile not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsH },
    });
  }

  let token;
  try {
    const body = await request.json();
    token = body?.token;
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsH },
    });
  }

  if (!token || typeof token !== 'string' || token.length > 4096) {
    return new Response(JSON.stringify({ success: false, error: 'Missing or invalid token' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsH },
    });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';

  const form = new FormData();
  form.append('secret',   env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  try {
    const res  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: form,
    });
    const data = await res.json();
    if (data.success) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsH },
      });
    }
    return new Response(JSON.stringify({ success: false }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...corsH },
    });
  } catch {
    // Fail closed — if verification service is unreachable, reject
    return new Response(JSON.stringify({ success: false, error: 'Verification unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsH },
    });
  }
}

export async function onRequestOptions({ request }) {
  const corsH = corsHeaders(request.headers.get('Origin') || '');
  return new Response(null, { status: 204, headers: corsH });
}
