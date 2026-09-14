const DEFAULT_REPO = 'addvaluewithai-hub/runactions';
const DEFAULT_BRANCH = 'main';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function authHeaders(env) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'qserve-video-editor' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

function decodeBase64Utf8(value) {
  const bin = atob(value.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

export async function onRequestGet({ params, env }) {
  const slug = safeSlug(params.slug);
  if (!slug) return json({ error: 'invalid slug' }, 400);
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = `editor/projects/${slug}.json`;
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: authHeaders(env) });
  if (!r.ok) return json({ error: 'project not found' }, r.status);
  const file = await r.json();
  return new Response(decodeBase64Utf8(file.content), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function onRequestPut({ request, params, env }) {
  const slug = safeSlug(params.slug);
  if (!slug) return json({ error: 'invalid slug' }, 400);
  if (!env.EDITOR_KEY || request.headers.get('X-Editor-Key') !== env.EDITOR_KEY) return json({ error: 'unauthorized' }, 401);
  if (!env.GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN is not configured' }, 503);

  const body = await request.json();
  if (body.slug !== slug || !Array.isArray(body.tracks)) return json({ error: 'invalid project document' }, 400);

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = `editor/projects/${slug}.json`;
  const headers = { ...authHeaders(env), 'Content-Type': 'application/json' };
  const current = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers });
  if (!current.ok) return json({ error: 'could not read current project' }, current.status);
  const currentFile = await current.json();

  const update = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      message: `Update ${slug} video timeline from QServe editor`,
      branch,
      sha: currentFile.sha,
      content: encodeBase64Utf8(`${JSON.stringify(body, null, 2)}\n`),
    }),
  });
  if (!update.ok) return json({ error: await update.text() }, update.status);
  const result = await update.json();
  return json({ ok: true, commit: result.commit?.sha || null });
}
