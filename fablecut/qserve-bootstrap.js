(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get('project') || 'rooftop-7000').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) throw new Error('Invalid QServe project slug');

  window.__QSERVE_PROJECT_SLUG__ = slug;
  const nativeFetch = window.fetch.bind(window);
  let lastRevision = 0;

  const projectApi = () => `/api/project?project=${encodeURIComponent(slug)}`;
  const seedUrl = () => `/projects/${encodeURIComponent(slug)}.json`;

  window.fetch = async (input, init = {}) => {
    let url = typeof input === 'string' ? input : input?.url;
    if (!url) return nativeFetch(input, init);

    const parsed = new URL(url, location.href);
    if (parsed.origin === location.origin && parsed.pathname === '/api/project') {
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

    return nativeFetch(input, init);
  };

  // FableCut's stock server uses SSE. Pages persistence is revision-based instead;
  // poll lightly so an external agent edit can appear without shipping a Node server.
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
    if (exportBtn) exportBtn.title = 'Local browser export. Final QServe render is triggered after you finish editing.';
  });
})();
