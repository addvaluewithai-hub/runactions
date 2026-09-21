#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch_fablecut_preview_playback.py <app.js>")

path = Path(sys.argv[1])
s = path.read_text()

old_play = '''function play() {
  if (state.audioHold) setAudioHold(false);
  if (state.playing) return;
  ensureAudio();
  runtime.audio.ctx.resume();
  if (playLimited()) {
    const { start, end } = playRange();
    // Parked at OUT after a limited play → restart at IN. Playhead before IN or
    // past OUT is a manual override: leave it and play from there.
    if (state.time >= end - 0.01 && state.time <= end + 0.02) state.time = start;
  } else if (state.time >= projDur() - 0.01) {
    state.time = 0;
  }
  state.playing = true;
  els.btnPlay.textContent = "⏸";
  els.btnPlay.classList.add("on");
}
'''

new_play = '''// QServe preview patch: FableCut's stock player advances the project clock
// immediately, even while active media elements are still loading/seeking. On
// browser editors that makes a short clip appear frozen/silent while the playhead
// runs ahead. Prime every active A/V element before starting the clock instead.
window.__QSERVE_PLAYBACK_PATCH__ = "prime-active-av-v1";
let qservePlaybackStarting = false;

function qserveWaitMedia(el, events, timeoutMs = 2200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const name of events) el.removeEventListener(name, finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const name of events) el.addEventListener(name, finish, { once: true });
  });
}

async function qservePrimeClipForPlayback(c, t) {
  const el = getClipEl(c);
  if (!el) return;
  const mt = mediaTimeAt(c, t);
  try { if (!el.paused) el.pause(); } catch {}

  if (el.readyState < 1) {
    try { el.load(); } catch {}
    await qserveWaitMedia(el, ["loadedmetadata", "loadeddata", "canplay", "error"]);
  }

  if (Number.isFinite(mt) && (el.seeking || Math.abs((el.currentTime || 0) - mt) > 0.035)) {
    try { el.currentTime = mt; } catch {}
    await qserveWaitMedia(el, ["seeked", "loadeddata", "canplay", "error"]);
  }

  // A seek can resolve before the decoded picture is actually presented. Give
  // video one short presentation window so Play starts on the correct frame.
  if (c.kind === "video" && typeof el.requestVideoFrameCallback === "function" && !el.error) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 450);
      try { el.requestVideoFrameCallback(done); } catch { done(); }
    });
  }
}

async function qservePrimePlaybackAt(t) {
  const active = project.clips.filter((c) =>
    (c.kind === "video" || c.kind === "audio")
    && isTrackEnabled(c.track)
    && activeAt(c, t)
  );
  await Promise.all(active.map((c) => qservePrimeClipForPlayback(c, t)));
}

async function play() {
  if (state.audioHold) setAudioHold(false);
  if (state.playing || qservePlaybackStarting) return;
  ensureAudio();
  try { await runtime.audio.ctx.resume(); } catch {}
  if (playLimited()) {
    const { start, end } = playRange();
    // Parked at OUT after a limited play → restart at IN. Playhead before IN or
    // past OUT is a manual override: leave it and play from there.
    if (state.time >= end - 0.01 && state.time <= end + 0.02) state.time = start;
  } else if (state.time >= projDur() - 0.01) {
    state.time = 0;
  }

  const startTime = state.time;
  qservePlaybackStarting = true;
  els.btnPlay.textContent = "…";
  els.btnPlay.classList.add("on");
  try {
    await qservePrimePlaybackAt(startTime);
  } catch (err) {
    console.warn("[QServe] preview prime failed; continuing playback", err);
  } finally {
    qservePlaybackStarting = false;
  }

  // Keep the project clock parked while media is primed. The first realtime tick
  // starts only after active picture + audio have sought to the requested point.
  state.time = startTime;
  state.playing = true;
  els.btnPlay.textContent = "⏸";
  els.btnPlay.classList.add("on");
  syncMedia();
}
'''

if s.count(old_play) != 1:
    raise SystemExit(f"FableCut play() patch anchor changed; expected 1 match, found {s.count(old_play)}")
s = s.replace(old_play, new_play, 1)

old_active = '''      if (el.playbackRate !== eff) { try { el.playbackRate = eff; } catch {} }
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - mt) > 0.25 * eff) { try { el.currentTime = mt; } catch {} }
      const vol = clamp(p.volume, 0, 4);
'''
new_active = '''      if (el.playbackRate !== eff) { try { el.playbackRate = eff; } catch {} }
      // Seek first, then play. Stock FableCut calls play() before assigning the
      // target currentTime, so the timeline clock can outrun a pending seek.
      const drift = Math.abs(el.currentTime - mt);
      const seekThreshold = 0.25 * eff;
      if (drift > seekThreshold && !el.seeking) {
        try {
          if (!el.paused) el.pause();
          el.currentTime = mt;
        } catch {}
      } else if (!el.seeking && el.readyState >= 2 && el.paused) {
        el.play().catch(() => {});
      }
      const vol = clamp(p.volume, 0, 4);
'''
if s.count(old_active) != 1:
    raise SystemExit(f"FableCut syncMedia active patch anchor changed; expected 1 match, found {s.count(old_active)}")
s = s.replace(old_active, new_active, 1)

old_else = '''    } else {
      if (!el.paused) el.pause();
      const g = runtime.clipGain.get(c.id);
'''
new_else = '''    } else {
      // Prime the next clip before the cut. This is intentionally lightweight:
      // seek its decode head while paused, 2.5 s before it becomes active.
      if (state.playing && enabled && (c.kind === "video" || c.kind === "audio")) {
        const untilStart = c.start - t;
        if (untilStart > 0 && untilStart <= 2.5) {
          const preMt = mediaTimeAt(c, c.start);
          if (el.readyState === 0) { try { el.load(); } catch {} }
          if (!el.seeking && Math.abs((el.currentTime || 0) - preMt) > 0.04) {
            try { el.currentTime = preMt; } catch {}
          }
        }
      }
      if (!el.paused) el.pause();
      const g = runtime.clipGain.get(c.id);
'''
if s.count(old_else) != 1:
    raise SystemExit(f"FableCut syncMedia prewarm patch anchor changed; expected 1 match, found {s.count(old_else)}")
s = s.replace(old_else, new_else, 1)

path.write_text(s)
print("Applied QServe FableCut preview playback patch")
