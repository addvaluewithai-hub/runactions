const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

function projectSlug(url) {
  return safeSlug(new URL(url).searchParams.get('project') || 'rooftop-7000');
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

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(await object.text());
}

export async function onRequestGet({ request, env }) {
  const slug = projectSlug(request.url);
  if (!slug) return json({ error: 'invalid project slug' }, 400);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);

  try {
    const manifest = await readJson(env.QSERVE_PROJECTS, `projects/${slug}/optimization.json`);
    return json(manifest || { ok: true, slug, segments: [], skipped: [] });
  } catch {
    return json({ error: 'stored optimization manifest is not valid JSON' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const slug = projectSlug(request.url);
  if (!slug) return json({ error: 'invalid project slug' }, 400);
  if (!sameOriginWrite(request)) return json({ error: 'cross-origin optimization requests are not allowed' }, 403);
  if (!env.QSERVE_PROJECTS) return json({ error: 'QSERVE_PROJECTS R2 binding is not configured' }, 503);
  if (!env.MEDIA_OPTIMIZER) return json({ error: 'MEDIA_OPTIMIZER service binding is not configured' }, 503);

  let project;
  try { project = await readJson(env.QSERVE_PROJECTS, `projects/${slug}/project.json`); }
  catch { return json({ error: 'stored project is not valid JSON' }, 500); }
  if (!project) return json({ error: 'project not found' }, 404);

  const origin = new URL(request.url).origin;
  const response = await env.MEDIA_OPTIMIZER.fetch('https://qserve-media-optimizer.internal/optimize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, origin, project }),
  });

  let result;
  try { result = await response.json(); }
  catch { return json({ error: `optimizer returned ${response.status} without JSON` }, 502); }
  if (!response.ok || !result?.ok) return json(result || { error: 'playback optimization failed' }, response.status || 502);

  const manifest = {
    ok: true,
    slug,
    sourceRevision: Number(project.revision || 0),
    generatedAt: result.generatedAt || new Date().toISOString(),
    segments: Array.isArray(result.segments) ? result.segments : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
  };

  await env.QSERVE_PROJECTS.put(
    `projects/${slug}/optimization.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        slug,
        sourceRevision: String(manifest.sourceRevision),
        generatedAt: manifest.generatedAt,
      },
    },
  );

  return json(manifest);
}
