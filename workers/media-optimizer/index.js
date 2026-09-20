const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Each timeline video clip gets its own physical preview file. This intentionally
// does NOT merge adjacent clips: after a split, the two pieces should behave like
// two small videos in the browser even though production rendering still uses the
// untouched original source.
const HANDLE_SECONDS = 1;
const MAX_SEGMENT_SECONDS = 55;
const MAX_SEGMENTS = 64;
const EPS = 0.001;

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

function safeId(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 72) || 'media';
}

function safeObjectName(value) {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return String(value).slice(0, 220);
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function clipSourceRange(clip, media) {
  if (!clip || clip.kind !== 'video') return null;
  const duration = Number(clip.duration || 0);
  const sourceIn = Number(clip.in || 0);
  const speed = Number(clip.props?.speed || 1);
  if (!(duration > EPS) || !(speed > 0) || !Number.isFinite(sourceIn)) return null;

  const usedEnd = sourceIn + duration * speed;
  if (usedEnd - sourceIn > MAX_SEGMENT_SECONDS) return null;

  const mediaDuration = Number(media?.duration);
  const maxEnd = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : Infinity;
  let start = Math.max(0, sourceIn - HANDLE_SECONDS);
  let end = Math.min(maxEnd, usedEnd + HANDLE_SECONDS);

  if (end - start > MAX_SEGMENT_SECONDS) {
    const spare = Math.max(0, MAX_SEGMENT_SECONDS - (usedEnd - sourceIn));
    const before = Math.min(sourceIn, spare / 2);
    const after = Math.max(0, spare - before);
    start = Math.max(0, sourceIn - before);
    end = Math.min(maxEnd, usedEnd + after);
  }

  if (!(end > start + EPS) || end - start > MAX_SEGMENT_SECONDS + EPS) return null;
  return {
    sourceIn: round3(sourceIn),
    sourceEnd: round3(usedEnd),
    start: round3(start),
    end: round3(end),
    speed,
  };
}

async function getSourceBody({ env, slug, origin, media }) {
  const raw = String(media?.src || '');
  const sourceUrl = new URL(raw, origin);
  if (sourceUrl.origin !== origin) throw new Error(`Refusing cross-origin media source: ${raw}`);

  let key = null;
  if (sourceUrl.pathname === '/api/media') {
    const requestSlug = safeSlug(sourceUrl.searchParams.get('project') || slug);
    const objectName = safeObjectName(sourceUrl.searchParams.get('key'));
    if (requestSlug !== slug || !objectName) throw new Error(`Invalid R2 media source: ${raw}`);
    key = `media/${slug}/${objectName}`;
  } else if (sourceUrl.pathname.startsWith('/media/')) {
    const filename = safeObjectName(decodeURIComponent(sourceUrl.pathname.split('/').pop() || ''));
    if (!filename) throw new Error(`Invalid static media source: ${raw}`);
    key = `sources/${slug}/${filename}`;
  } else {
    throw new Error(`Unsupported media source for playback optimization: ${raw}`);
  }

  const source = await env.QSERVE_PROJECTS.get(key);
  if (!source?.body) throw new Error(`Playback source mirror is missing in R2: ${key}`);
  return source.body;
}

async function optimizeClip({ env, slug, origin, clip, media, range, ordinal }) {
  const clipKey = safeId(clip.id);
  const mediaKey = safeId(media.id);
  const startMs = Math.max(0, Math.round(range.start * 1000));
  const endMs = Math.max(startMs + 1, Math.round(range.end * 1000));
  const objectName = `opt-${clipKey}-${mediaKey}-${startMs}-${endMs}.mp4`;
  const objectKey = `media/${slug}/${objectName}`;
  const proxyMediaId = `__qserve_opt_${clipKey}_${startMs}_${endMs}`;

  const existing = await env.QSERVE_PROJECTS.head(objectKey);
  if (!existing) {
    const sourceBody = await getSourceBody({ env, slug, origin, media });
    const duration = round3(range.end - range.start);
    const result = env.MEDIA
      .input(sourceBody)
      .transform({ width: 360, fit: 'contain' })
      .output({
        mode: 'video',
        time: `${range.start}s`,
        duration: `${duration}s`,
        audio: false,
      });

    const transformed = await result.response();
    if (!transformed.ok) {
      throw new Error(`Media transformation failed (${transformed.status}) for ${clip.name || media.name || clip.id}`);
    }
    const contentType = transformed.headers.get('content-type') || 'video/mp4';
    const mediaBytes = await transformed.arrayBuffer();
    await env.QSERVE_PROJECTS.put(objectKey, mediaBytes, {
      httpMetadata: { contentType },
      customMetadata: {
        slug,
        purpose: 'playback-optimization',
        originalMediaId: String(media.id),
        originalClipId: String(clip.id),
        sourceStart: String(range.start),
        sourceEnd: String(range.end),
        generatedAt: new Date().toISOString(),
      },
    });
  }

  const baseName = String(clip.name || media.name || 'Video clip').trim();
  return {
    clipId: clip.id,
    clipIds: [clip.id],
    proxyMediaId,
    proxyName: `⚡ ${String(ordinal).padStart(2, '0')} · ${baseName}`,
    originalMediaId: media.id,
    sourceStart: range.start,
    sourceEnd: range.end,
    originalSourceIn: range.sourceIn,
    originalSourceEnd: range.sourceEnd,
    proxySrc: `/api/media?project=${encodeURIComponent(slug)}&key=${encodeURIComponent(objectName)}`,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'qserve-media-optimizer' });
    }
    if (request.method !== 'POST' || url.pathname !== '/optimize') {
      return json({ error: 'not found' }, 404);
    }
    if (!env.QSERVE_PROJECTS || !env.MEDIA) {
      return json({ error: 'optimizer bindings are not configured' }, 503);
    }

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: 'invalid JSON' }, 400); }

    const slug = safeSlug(payload?.slug);
    const origin = String(payload?.origin || '').replace(/\/$/, '');
    const project = payload?.project;
    if (!slug || !/^https:\/\//i.test(origin) || !project || !Array.isArray(project.media) || !Array.isArray(project.clips)) {
      return json({ error: 'invalid optimization request' }, 400);
    }

    const disabled = new Set(Array.isArray(project.disabledTracks) ? project.disabledTracks : []);
    const mediaById = new Map(project.media.map((m) => [m.id, m]));
    const skipped = [];
    const jobs = [];

    const videoClips = project.clips
      .filter((clip) => clip?.kind === 'video' && !disabled.has(clip.track))
      .sort((a, b) => Number(a.start || 0) - Number(b.start || 0) || String(a.id).localeCompare(String(b.id)));

    for (const clip of videoClips) {
      const media = mediaById.get(clip.mediaId);
      if (!media || media.kind !== 'video') {
        skipped.push({ clipId: clip.id, reason: 'video media is missing' });
        continue;
      }
      const range = clipSourceRange(clip, media);
      if (!range) {
        skipped.push({ clipId: clip.id, reason: 'clip is too long or has unsupported timing' });
        continue;
      }
      jobs.push({ clip, media, range, ordinal: jobs.length + 1 });
    }

    if (jobs.length > MAX_SEGMENTS) {
      return json({ error: `too many playback clips (${jobs.length}); maximum is ${MAX_SEGMENTS}` }, 400);
    }

    const segments = [];
    for (const job of jobs) {
      try {
        segments.push(await optimizeClip({ env, slug, origin, ...job }));
      } catch (error) {
        skipped.push({
          mediaId: job.media?.id,
          clipId: job.clip?.id,
          clipIds: job.clip?.id ? [job.clip.id] : [],
          reason: String(error?.message || error),
        });
      }
    }

    return json({
      ok: true,
      slug,
      revision: Number(project.revision || 0),
      generatedAt: new Date().toISOString(),
      mode: 'one-proxy-per-clip',
      segments,
      skipped,
    });
  },
};
