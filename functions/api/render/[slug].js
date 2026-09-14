const DEFAULT_REPO = 'addvaluewithai-hub/runactions';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

export async function onRequestPost({ request, params, env }) {
  const slug = safeSlug(params.slug);
  if (!slug) return json({ error: 'invalid slug' }, 400);
  if (!env.EDITOR_KEY || request.headers.get('X-Editor-Key') !== env.EDITOR_KEY) return json({ error: 'unauthorized' }, 401);
  if (!env.GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN is not configured' }, 503);
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const workflow = env.RENDER_WORKFLOW || 'render-editor-project.yml';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'qserve-video-editor',
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main', inputs: { slug } }),
  });
  if (!r.ok) return json({ error: await r.text() }, r.status);
  return json({ ok: true, message: `GitHub render queued for ${slug}` }, 202);
}
