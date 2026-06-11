// Cloudflare Turnstile server-side verification
// Required env secret: TURNSTILE_SECRET
// Add it in: Cloudflare Pages → Settings → Environment Variables

export async function onRequestPost({ env, request }) {
  const corsH = {
    'Access-Control-Allow-Origin': 'https://feetracker2.pages.dev',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };

  if (!env.TURNSTILE_SECRET) {
    return new Response(JSON.stringify({ success: false, error: 'Turnstile not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsH }
    });
  }

  let token;
  try {
    const body = await request.json();
    token = body?.token;
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsH }
    });
  }

  if (!token) {
    return new Response(JSON.stringify({ success: false, error: 'Missing token' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsH }
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
        status: 200, headers: { 'Content-Type': 'application/json', ...corsH }
      });
    }
    return new Response(JSON.stringify({ success: false, codes: data['error-codes'] }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...corsH }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: 'Verification failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsH }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': 'https://feetracker2.pages.dev',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
