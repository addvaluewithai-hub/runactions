// QServe editor bridge. Kept separate from upstream FableCut so upgrades remain replaceable.
(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get('project') || 'rooftop-7000').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) throw new Error('Invalid QServe project slug');

  window.__QSERVE_PROJECT_SLUG__ = slug;
  const nativeFetch = window.fetch.bind(window);
  let lastRevision = 0;
  let libraryManifest = null;
  let optimizationManifest = { segments: [], skipped: [] };
  let optimizationLoaded = false;
  let optimizeButton = null;
  let activeOptimizedClips = 0;

  const projectApi = () => `/api/project?project=${encodeURIComponent(slug)}`;
  const optimizeApi = () => `/api/optimize?project=${encodeURIComponent(slug)}`;
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

  async function loadOptimizationManifest(force = false) {
    if (optimizationLoaded && !force) return optimizationManifest;
    try {
      const r = await nativeFetch(optimizeApi(), { cache: 'no-store' });
      if (r.ok) {
        const body = await r.json();
        optimizationManifest = {
          ...body,
          segments: Array.isArray(body?.segments) ? body.segments : [],
          skipped: Array.isArray(body?.skipped) ? body.skipped : [],
        };
      } else {
        optimizationManifest = { segments: [], skipped: [] };
      }
    } catch {
      optimizationManifest = { segments: [], skipped: [] };
    }
    optimizationLoaded = true;
    refreshOptimizeButton();
    return optimizationManifest;
  }

  function segmentLength(segment) {
    return Math.max(0, Number(segment?.sourceEnd || 0) - Number(segment?.sourceStart || 0));
  }

  function applyOptimization(project) {
    const segments = Array.isArray(optimizationManifest?.segments) ? optimizationManifest.segments : [];
    if (!segments.length || !project || !Array.isArray(project.media) || !Array.isArray(project.clips)) {
      activeOptimizedClips = 0;
      refreshOptimizeButton();
      return project;
    }

    const out = typeof structuredClone === 'function'
      ? structuredClone(project)
      : JSON.parse(JSON.stringify(project));
    const mediaById = new Map(out.media.map((m) => [m.id, m]));
    const addedProxyIds = new Set(out.media.map((m) => m.id));
    const sorted = [...segments].sort((a, b) => segmentLength(a) - segmentLength(b));
    let applied = 0;

    for (const clip of out.clips) {
      if (!clip || clip.kind !== 'video') continue;
      const sourceIn = Number(clip.in || 0);
      const duration = Number(clip.duration || 0);
      const speed = Number(clip.props?.speed || 1);
      if (!(duration > 0) || !(speed > 0)) continue;
      const sourceEnd = sourceIn + duration * speed;

      const segment = sorted.find((s) =>
        s?.originalMediaId === clip.mediaId
        && Number(s.sourceStart) <= sourceIn + 0.002
        && Number(s.sourceEnd) >= sourceEnd - 0.002
      );
      if (!segment) continue;

      const original = mediaById.get(segment.originalMediaId);
      if (!original) continue;
      const proxyId = String(segment.proxyMediaId || '');
      const proxySrc = String(segment.proxySrc || '');
      if (!proxyId || !proxySrc) continue;

      if (!addedProxyIds.has(proxyId)) {
        out.media.push({
          ...original,
          id: proxyId,
          name: `⚡ ${original.name || 'Optimized preview'}`,
          src: proxySrc,
          duration: segmentLength(segment),
        });
        addedProxyIds.add(proxyId);
      }

      clip.mediaId = proxyId;
      clip.in = Math.max(0, sourceIn - Number(segment.sourceStart || 0));
      applied += 1;
    }

    activeOptimizedClips = applied;
    refreshOptimizeButton();
    return out;
  }

  function canonicalizeProject(project) {
    if (!project || !Array.isArray(project.media) || !Array.isArray(project.clips)) return project;
    const segments = Array.isArray(optimizationManifest?.segments) ? optimizationManifest.segments : [];
    if (!segments.length) return project;

    const out = typeof structuredClone === 'function'
      ? structuredClone(project)
      : JSON.parse(JSON.stringify(project));
    const byProxy = new Map(segments.map((s) => [s.proxyMediaId, s]));

    for (const clip of out.clips) {
      const segment = byProxy.get(clip?.mediaId);
      if (!segment) continue;
      clip.mediaId = segment.originalMediaId;
      clip.in = Number(segment.sourceStart || 0) + Number(clip.in || 0);
    }

    out.media = out.media.filter((m) => !byProxy.has(m?.id));
    return out;
  }

  function jsonResponse(body, sourceResponse) {
    const headers = new Headers(sourceResponse?.headers || {});
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(`${JSON.stringify(body, null, 2)}\n`, {
      status: sourceResponse?.status || 200,
      statusText: sourceResponse?.statusText || '',
      headers,
    });
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    if (!rawUrl) return nativeFetch(input, init);

    const parsed = new URL(rawUrl, location.href);
    if (parsed.origin !== location.origin) return nativeFetch(input, init);

    if (parsed.pathname === '/api/project') {
      const method = String(init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();

      if (method === 'PUT') {
        let text = typeof init?.body === 'string' ? init.body : null;
        if (!text && typeof Request !== 'undefined' && input instanceof Request) {
          try { text = await input.clone().text(); } catch {}
        }

        let nextInit = init;
        if (text) {
          try {
            const parsedProject = JSON.parse(text);
            const canonical = canonicalizeProject(parsedProject);
            nextInit = { ...init, body: JSON.stringify(canonical, null, 2) };
          } catch {}
        }

        const response = await nativeFetch(projectApi(), nextInit);
        if (response.ok) {
          try {
            const body = await response.clone().json();
            lastRevision = Number(body.revision || lastRevision || 0);
          } catch {}
        }
        return response;
      }

      let response = await nativeFetch(projectApi(), init);
      if (method === 'GET' && (response.status === 404 || response.status === 503)) {
        response = await nativeFetch(seedUrl(), { cache: 'no-store' });
      }
      if (!response.ok || method !== 'GET') return response;

      try {
        const body = await response.clone().json();
        lastRevision = Number(body.revision || lastRevision || 0);
        await loadOptimizationManifest();
        return jsonResponse(applyOptimization(body), response);
      } catch {
        return response;
      }
    }

    if (parsed.pathname === '/api/upload') {
      return nativeFetch(withProjectParam(parsed), init);
    }

    if (parsed.pathname === '/api/import-url') {
      return nativeFetch(withProjectParam(parsed), init);
    }

    if (parsed.pathname === '/api/media') {
      return nativeFetch(withProjectParam(parsed), init);
    }

    if (parsed.pathname === '/api/library') {
      return staticLibrary(parsed.searchParams.get('dir') || '');
    }

    if (parsed.pathname === '/api/export/ffmpeg') {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return nativeFetch(input, init);
  };

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

  function refreshOptimizeButton() {
    if (!optimizeButton) return;
    if (optimizeButton.dataset.busy === '1') return;
    if (activeOptimizedClips > 0) {
      optimizeButton.textContent = `⚡ Optimized (${activeOptimizedClips})`;
      optimizeButton.title = 'Playback proxies are active. Click to rebuild them from the latest saved timeline.';
    } else if (optimizationManifest?.segments?.length) {
      optimizeButton.textContent = '⚡ Re-optimize';
      optimizeButton.title = 'Optimized segments exist, but the current timeline has changed. Rebuild playback proxies.';
    } else {
      optimizeButton.textContent = '⚡ Optimize Playback';
      optimizeButton.title = 'Create short Cloudflare playback proxies for the video ranges actually used on the timeline.';
    }
  }

  async function optimizePlayback() {
    if (!optimizeButton || optimizeButton.dataset.busy === '1') return;
    const ok = window.confirm(
      'Optimize Playback will create short preview videos for the ranges used on the timeline, then reload the editor.\n\nYour saved project and production sources stay unchanged, but the current Undo history will reset. Continue?'
    );
    if (!ok) return;

    optimizeButton.dataset.busy = '1';
    optimizeButton.disabled = true;
    optimizeButton.textContent = '⚡ Optimizing…';

    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await nativeFetch(optimizeApi(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);

      optimizationManifest = body;
      optimizationLoaded = true;
      optimizeButton.textContent = `✓ Optimized ${body.segments?.length || 0} segment${body.segments?.length === 1 ? '' : 's'}`;
      optimizeButton.title = body.skipped?.length
        ? `${body.skipped.length} long/unsupported clip(s) kept on their existing preview source.`
        : 'Playback optimization completed.';
      setTimeout(() => location.reload(), 650);
    } catch (error) {
      optimizeButton.dataset.busy = '0';
      optimizeButton.disabled = false;
      refreshOptimizeButton();
      window.alert(`Optimize Playback failed: ${error?.message || error}`);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    document.title = `QServe Studio — ${slug}`;
    const exportBtn = document.getElementById('btnExport');
    if (exportBtn) {
      exportBtn.title = 'Preview/local export only. Tell ChatGPT when the edit is final and QServe will render it through GitHub Actions.';
    }

    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight && !document.getElementById('btnQserveOptimize')) {
      optimizeButton = document.createElement('button');
      optimizeButton.type = 'button';
      optimizeButton.className = 'btn ghost';
      optimizeButton.id = 'btnQserveOptimize';
      optimizeButton.textContent = '⚡ Optimize Playback';
      optimizeButton.addEventListener('click', optimizePlayback);
      if (exportBtn && exportBtn.parentNode === topbarRight) topbarRight.insertBefore(optimizeButton, exportBtn);
      else topbarRight.appendChild(optimizeButton);
      refreshOptimizeButton();
      setTimeout(() => loadOptimizationManifest().catch(() => {}), 500);
    }
  });
})();
