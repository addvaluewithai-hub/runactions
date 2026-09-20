const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const HANDLE_SECONDS = 3;
const MERGE_GAP_SECONDS = 6;
const MAX_SEGMENT_SECONDS = 55;
const MAX_SEGMENTS = 24;
const EPS = 0.001;

function safeSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(value || '') ? value : null;
}

function safeId(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 72) || 'media';
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
  return { start: round3(start), end: round3(end), speed };
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + MERGE_GAP_SECONDS && Math.max(last.end, range.end) - last.start <= MAX_SEGMENT_SECONDS) {
      last.end = round3(Math.max(last.end, range.end));
      last.clipIds.push(...range.clipIds);
    } else {
      out.push({ ...range, clipIds: [...range.clipIds] });
    }
  }
  return out;
}

async function optimizeSegment({ env, slug, origin, media, range }) {
  const mediaKey = safeId(media.id);
  const startMs = Math.max(0, Math.round(range.start * 1000));
  const endMs = Math.max(startMs + 1, Math.round(range.end * 1000));
  const objectName = `opt-${mediaKey}-${startMs}-${endMs}.mp4`;
  const objectKey = `media/${slug}/${objectName}`;
  const proxyMediaId = `__qserve_opt_${mediaKey}_${startMs}_${endMs}`;

  const existing = await env.QSERVE_PROJECTS.head(objectKey);
  if (!existing) {
    const sourceUrl = new URL(media.src, origin);
    if (sourceUrl.origin !== origin) throw new Error(`Refusing cross-origin media source: ${media.src}`);
    if (!(sourceUrl.pathname.startsWith('/media/') || sourceUrl.pathname === '/api/media')) {
      throw new Error(`Unsupported media source for playback optimization: ${media.src}`);
    }

    const source = await fetch(sourceUrl.toString(), { cache: 'force-cache' });
    if (!source.ok || !source.body) throw new Error(`Source fetch failed (${source.status}) for ${media.name || media.id}`);

    const duration = round3(range.end - range.start);
    const result = env.MEDIA
      .input(source.body)
      .transform({ width: 360, fit: 'contain' })
      .output({
        mode: 'video',
        time: `${range.start}s`,
        duration: `${duration}s`,
        audio: false,
      });

    const contentType = await result.contentType();
    const mediaBody = await result.media();
    await env.QSERVE_PROJECTS.put(objectKey, mediaBody, {
      httpMetadata: { contentType: contentType || 'video/mp4' },
      customMetadata: {
        slug,
        purpose: 'playback-optimization',
        originalMediaId: String(media.id),
        sourceStart: String(range.start),
        sourceEnd: String(range.end),
        generatedAt: new Date().toISOString(),
      },
    });
  }

  return {
    proxyMediaId,
    originalMediaId: media.id,
    sourceStart: range.start,
    sourceEnd: range.end,
    proxySrc: `/api/media?project=${encodeURIComponent(slug)}&key=${encodeURIComponent(objectName)}`,
    clipIds: range.clipIds,
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
    const grouped = new Map();
    const skipped = [];

    for (const clip of project.clips) {
      if (clip?.kind !== 'video' || disabled.has(clip.track)) continue;
      const media = mediaById.get(clip.mediaId);
      if (!media || media.kind !== 'video') continue;
      const range = clipSourceRange(clip, media);
      if (!range) {
        skipped.push({ clipId: clip.id, reason: 'clip is too long or has unsupported timing' });
        continue;
      }
      const list = grouped.get(media.id) || [];
      list.push({ start: range.start, end: range.end, clipIds: [clip.id] });
      grouped.set(media.id, list);
    }

    const jobs = [];
    for (const [mediaId, ranges] of grouped) {
      const media = mediaById.get(mediaId);
      for (const range of mergeRanges(ranges)) jobs.push({ media, range });
    }

    if (jobs.length > MAX_SEGMENTS) {
      return json({ error: `too many playback segments (${jobs.length}); maximum is ${MAX_SEGMENTS}` }, 400);
    }

    const segments = [];
    for (const job of jobs) {
      try {
        segments.push(await optimizeSegment({ env, slug, origin, media: job.media, range: job.range }));
      } catch (error) {
        skipped.push({
          mediaId: job.media?.id,
          clipIds: job.range?.clipIds || [],
          reason: String(error?.message || error),
        });
      }
    }

    return json({
      ok: true,
      slug,
      revision: Number(project.revision || 0),
      generatedAt: new Date().toISOString(),
      segments,
      skipped,
    });
  },
};
