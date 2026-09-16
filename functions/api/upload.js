const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

function safeName(value) {
  return String(value || 'media')
    .replace(/[^\p{L}\p{N}._ ()\[\]-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'media';
}

function sameOriginWrite(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === expected;
  const referer = request.headers.get('referer');
  if (referer) {
    try { return new URL(referer).origin === expected; } catch { return false; }
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  if (!sameOriginWrite(request)) return json({ error: 'cross-origin media writes are not allowed' }, 403);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  const url = new URL(request.url);
  const slug = safeSlug(url.searchParams.get('project') || '');
  if (!slug) return json({ error: 'invalid project slug' }, 400);
  if (!request.body) return json({ error: 'empty upload' }, 400);

  const name = safeName(url.searchParams.get('name'));
  const id = crypto.randomUUID();
  const key = `media/${slug}/${id}-${name}`;
  const contentType = request.headers.get('content-type') || 'application/octet-stream';

  await env.QSERVE_PROJECTS.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: { slug, originalName: name, uploadedAt: new Date().toISOString() },
  });

  const src = `/api/media?project=${encodeURIComponent(slug)}&key=${encodeURIComponent(`${id}-${name}`)}`;
  return json({ ok: true, name, src });
}
