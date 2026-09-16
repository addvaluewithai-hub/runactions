(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get('project') || 'rooftop-7000').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) throw new Error('Invalid QServe project slug');

  window.__QSERVE_PROJECT_SLUG__ = slug;
  const nativeFetch = window.fetch.bind(window);
  let lastRevision = 0;
  let libraryManifest = null;

  const projectApi = () => `/api/project?project=${encodeURIComponent(slug)}`;
  const seedUrl = () => `/projects/${encodeURIComponent(slug)}.json`;

  function withProjectParam(parsed) {
    parsed.searchParams.set('project', slug);
    return parsed.pathname + parsed.search + parsed.hash;
  }

  async function staticLibrary(dir) {
    if (!libraryManifest) {
      const r = await nativeFetch('/library-manifest.json', { cache: 'force-cache' });
      if (!r.ok) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      libraryManifest = await r.json();
    }
    return new Response(JSON.stringify(libraryManifest?.[dir] || []), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    if (!rawUrl) return nativeFetch(input, init);

    const parsed = new URL(rawUrl, location.href);
    if (parsed.origin !== location.origin) return nativeFetch(input, init);

    if (parsed.pathname === '/api/project') {
      const method = String(init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      const response = await nativeFetch(projectApi(), init);

      if (method === 'GET' && (response.status === 404 || response.status === 503)) {
        const seed = await nativeFetch(seedUrl(), { cache: 'no-store' });
        if (seed.ok) {
          try {
            const body = await seed.clone().json();
            lastRevision = Number(body.revision || 0);
          } catch {}
        }
        return seed;
      }

      if (response.ok) {
        try {
          const body = await response.clone().json();
          lastRevision = Number(body.revision || lastRevision || 0);
        } catch {}
      }
      return response;
    }

    // FableCut sends raw file bodies to /api/upload?name=... when connected.
    // Scope every upload to this QServe project so Replace Media and drag/drop
    // survive page refreshes and are available to the later GitHub render.
    if (parsed.pathname === '/api/upload') {
      return nativeFetch(withProjectParam(parsed), init);
    }

    // The stock editor asks /api/media for server media discovery. Scope that
    // request too, while preserving keyed /api/media URLs stored in project.json.
    if (parsed.pathname === '/api/media') {
      return nativeFetch(withProjectParam(parsed), init);
    }

    // Keep FableCut's bundled SFX, elements, animated SVGs and custom fonts on
    // Pages without needing its Node server just to list static files.
    if (parsed.pathname === '/api/library') {
      return staticLibrary(parsed.searchParams.get('dir') || '');
    }

    // Final production export is intentionally not a browser/server concern in
    // QServe. FableCut may probe its stock Node ffmpeg endpoint; report it as
    // unavailable so the UI never implies that Pages is our production renderer.
    if (parsed.pathname === '/api/export/ffmpeg') {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return nativeFetch(input, init);
  };

  // FableCut's stock Node server uses SSE. Pages persistence is revision-based
  // instead; poll lightly so edits written by an agent can show up without a
  // permanent Node process.
  async function pollRevision() {
    try {
      const r = await nativeFetch(projectApi(), { cache: 'no-store' });
      if (!r.ok) return;
      const p = await r.json();
      const rev = Number(p.revision || 0);
      if (lastRevision && rev > lastRevision) location.reload();
      else if (rev) lastRevision = rev;
    } catch {}
  }
  setInterval(pollRevision, 10000);

  window.addEventListener('DOMContentLoaded', () => {
    document.title = `QServe Studio — ${slug}`;
    const exportBtn = document.getElementById('btnExport');
    if (exportBtn) {
      exportBtn.title = 'Preview/local export only. Tell ChatGPT when the edit is final and QServe will render it through GitHub Actions.';
    }
  });
})();
