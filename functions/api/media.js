const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

function safeObjectName(value) {
  // Upload API returns exactly one opaque filename segment; reject paths.
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return /^[\p{L}\p{N}._ ()\[\]-]{1,180}$/u.test(value) ? value : null;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return { invalid: true };

  let start;
  let end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      return { invalid: true };
    }
    if (start >= size) return { unsatisfiable: true };
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  const url = new URL(request.url);
  const slug = safeSlug(url.searchParams.get('project'));
  const name = safeObjectName(url.searchParams.get('key'));
  if (!slug || !name) return json({ error: 'invalid media request' }, 400);

  const key = `media/${slug}/${name}`;
  const head = await env.QSERVE_PROJECTS.head(key);
  if (!head) return json({ error: 'media not found' }, 404);

  const size = Number(head.size || 0);
  const type = head.httpMetadata?.contentType || 'application/octet-stream';
  const common = {
    'accept-ranges': 'bytes',
    'content-type': type,
    'cache-control': 'public, max-age=31536000, immutable',
    'etag': head.httpEtag,
    'last-modified': head.uploaded?.toUTCString?.() || new Date().toUTCString(),
  };

  const range = parseRange(request.headers.get('range'), size);
  if (range?.invalid || range?.unsatisfiable) {
    return new Response(null, {
      status: 416,
      headers: { ...common, 'content-range': `bytes */${size}` },
    });
  }

  if (range) {
    const headers = {
      ...common,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.length),
    };
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
    const object = await env.QSERVE_PROJECTS.get(key, { range: { offset: range.start, length: range.length } });
    if (!object) return json({ error: 'media not found' }, 404);
    return new Response(object.body, { status: 206, headers });
  }

  const headers = { ...common, 'content-length': String(size) };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const object = await env.QSERVE_PROJECTS.get(key);
  if (!object) return json({ error: 'media not found' }, 404);
  return new Response(object.body, { status: 200, headers });
}
