const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  },
});

function projectSlug(url) {
  const value = new URL(url).searchParams.get('project') || 'rooftop-7000';
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value) ? value : null;
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

async function readProject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(await object.text());
}

export async function onRequestGet({ request, env }) {
  const slug = projectSlug(request.url);
  if (!slug) return json({ error: 'invalid project slug' }, 400);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  const key = `projects/${slug}/project.json`;
  const object = await env.QSERVE_PROJECTS.get(key);
  if (!object) return json({ error: 'project has not been saved to Cloudflare yet' }, 404);

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'etag': object.httpEtag,
    },
  });
}

export async function onRequestPut({ request, env }) {
  const slug = projectSlug(request.url);
  if (!slug) return json({ error: 'invalid project slug' }, 400);
  if (!sameOriginWrite(request)) return json({ error: 'cross-origin project writes are not allowed' }, 403);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  let incoming;
  try { incoming = await request.json(); }
  catch { return json({ error: 'invalid JSON' }, 400); }

  if (!incoming || !Array.isArray(incoming.media) || !Array.isArray(incoming.clips)) {
    return json({ error: 'invalid FableCut project document' }, 400);
  }
  if (!Number.isFinite(Number(incoming.revision))) {
    return json({ error: 'project revision is required' }, 400);
  }

  const key = `projects/${slug}/project.json`;
  let current = null;
  try { current = await readProject(env.QSERVE_PROJECTS, key); }
  catch { return json({ error: 'stored project is not valid JSON' }, 500); }

  if (current && Number(incoming.revision) <= Number(current.revision || 0)) {
    return json({
      error: 'revision conflict',
      currentRevision: Number(current.revision || 0),
      incomingRevision: Number(incoming.revision),
    }, 409);
  }

  const body = `${JSON.stringify(incoming, null, 2)}\n`;
  await env.QSERVE_PROJECTS.put(key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { slug, revision: String(incoming.revision), savedAt: new Date().toISOString() },
  });

  return json({ ok: true, slug, revision: Number(incoming.revision) });
}
