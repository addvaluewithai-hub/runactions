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

function blockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.local')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  return false;
}

export async function onRequestPost({ request, env }) {
  if (!sameOriginWrite(request)) return json({ error: 'cross-origin imports are not allowed' }, 403);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  const slug = safeSlug(new URL(request.url).searchParams.get('project') || '');
  if (!slug) return json({ error: 'invalid project slug' }, 400);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON' }, 400); }

  let remote;
  try { remote = new URL(String(body?.url || '')); }
  catch { return json({ error: 'invalid URL' }, 400); }
  if (remote.protocol !== 'https:') return json({ error: 'URL must use HTTPS' }, 400);
  if (remote.username || remote.password || blockedHost(remote.hostname)) return json({ error: 'URL host is not allowed' }, 400);

  let upstream;
  try {
    upstream = await fetch(remote.toString(), { redirect: 'follow', headers: { 'user-agent': 'QServe-FableCut/1.0' } });
  } catch (e) {
    return json({ error: `could not download URL: ${e?.message || e}` }, 502);
  }
  if (!upstream.ok || !upstream.body) return json({ error: `remote server returned ${upstream.status}` }, 502);

  const finalUrl = new URL(upstream.url || remote.toString());
  if (finalUrl.protocol !== 'https:' || blockedHost(finalUrl.hostname)) return json({ error: 'redirected URL host is not allowed' }, 400);

  const declared = Number(upstream.headers.get('content-length') || 0);
  const maxBytes = 250 * 1024 * 1024;
  if (declared > maxBytes) return json({ error: 'remote media is larger than 250 MB' }, 413);

  const fallbackName = finalUrl.pathname.split('/').filter(Boolean).pop() || 'imported-media';
  const name = safeName(fallbackName);
  const id = crypto.randomUUID();
  const objectName = `${id}-${name}`;
  const key = `media/${slug}/${objectName}`;
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  try {
    await env.QSERVE_PROJECTS.put(key, upstream.body, {
      httpMetadata: { contentType },
      customMetadata: { slug, originalName: name, sourceUrl: remote.toString(), uploadedAt: new Date().toISOString() },
    });
  } catch (e) {
    return json({ error: `could not persist imported media: ${e?.message || e}` }, 500);
  }

  const src = `/api/media?project=${encodeURIComponent(slug)}&key=${encodeURIComponent(objectName)}`;
  return json({ ok: true, name, src });
}
