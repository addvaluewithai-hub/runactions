import json
import os
import re
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel
from google import genai

OUT = Path("out")
OUT.mkdir(exist_ok=True)
TALK_VIDEO = os.getenv("TALK_VIDEO", "talk.mp4")
PRODUCT_VIDEO = os.getenv("PRODUCT_VIDEO", "product.mp4")
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
API_KEY = os.environ["GEMINI_API_KEY"]
client = genai.Client(api_key=API_KEY)


def duration(path: str) -> float:
    raw = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path
    ], text=True).strip()
    return float(raw)


def clean_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def ask(prompt: str):
    r = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config={"temperature": 0.0, "response_mime_type": "application/json"},
    )
    return clean_json(r.text)


talk_duration = duration(TALK_VIDEO)
product_duration = duration(PRODUCT_VIDEO)

# Audio timestamps are produced by Whisper, while Gemini is used for semantic understanding.
whisper = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=4)
segments_iter, info = whisper.transcribe(
    TALK_VIDEO,
    language="ar",
    beam_size=5,
    vad_filter=True,
    word_timestamps=True,
    condition_on_previous_text=True,
)

segments = []
words = []
for s in segments_iter:
    seg = {
        "start": round(float(s.start), 2),
        "end": round(float(s.end), 2),
        "text": s.text.strip(),
    }
    segments.append(seg)
    if s.words:
        for w in s.words:
            words.append({
                "start": round(float(w.start), 2),
                "end": round(float(w.end), 2),
                "text": w.word.strip(),
            })

aligned_transcript = {
    "duration_seconds": round(talk_duration, 3),
    "detected_language": getattr(info, "language", "ar"),
    "segments": segments,
    "words": words,
}
(OUT / "aligned_transcript.json").write_text(
    json.dumps(aligned_transcript, ensure_ascii=False, indent=2), encoding="utf-8"
)

anchor_prompt = f'''
You are a video editor. Below is a Whisper transcript with AUDIO-ALIGNED timestamps from an Egyptian Arabic QServe sales video. The timestamps are authoritative; do not invent or rescale them.

TRANSCRIPT:\n{json.dumps(segments, ensure_ascii=False)}

Return ONLY JSON:
{{
  "anchors": [
    {{"id": string, "start": number, "end": number, "quote": string, "visual_recommendation": string}}
  ]
}}

Identify these moments when actually present: qserve_intro, qr_intro, digital_menu, dashboard_menu_control, call_waiter, request_status, escalation, customization, feedback, dashboard_visibility, personalized_mockup, free_trial, closing_cta.
For personalized_mockup, find the exact sentence where the speaker says the equivalent of "ده تصور سريع للشكل اللي QServe ممكن يبقى عليه عندكم".
Use start/end values copied from the smallest transcript segment(s) that contain each moment. Never output a timestamp outside 0..{talk_duration:.3f}.
'''
anchors = ask(anchor_prompt)
(OUT / "aligned_anchors.json").write_text(
    json.dumps(anchors, ensure_ascii=False, indent=2), encoding="utf-8"
)

# Gemini's visual shot boundaries can be stretched by odd mobile-recording timestamps.
# Preserve its semantic shot labels, but map them onto the actual ffprobe duration.
raw_product = json.loads((OUT / "product_shots.json").read_text(encoding="utf-8"))
reported = float(raw_product.get("duration_seconds") or product_duration)
scale = product_duration / reported if reported > 0 else 1.0
scaled_shots = []
for shot in raw_product.get("shots", []):
    x = dict(shot)
    x["start"] = round(max(0.0, float(shot["start"]) * scale), 2)
    x["end"] = round(min(product_duration, float(shot["end"]) * scale), 2)
    scaled_shots.append(x)
product_aligned = {
    "duration_seconds": round(product_duration, 3),
    "source_reported_duration": reported,
    "timestamp_scale_applied": scale,
    "shots": scaled_shots,
}
(OUT / "product_shots_aligned.json").write_text(
    json.dumps(product_aligned, ensure_ascii=False, indent=2), encoding="utf-8"
)

plan_prompt = f'''
Create a continuous edit plan for a vertical 1080x1920 personalized restaurant outreach video.

Authoritative talking-video duration: {talk_duration:.3f}s
Authoritative audio-aligned transcript:\n{json.dumps(segments, ensure_ascii=False)}
Semantic anchors:\n{json.dumps(anchors, ensure_ascii=False)}
Product screen shots with corrected timestamps:\n{json.dumps(product_aligned, ensure_ascii=False)}

Brief:
- Original talking video audio stays as master audio for the entire video.
- 0 to roughly 2.5-3.0s: personalized tabletop QR image full-screen.
- Then presenter full-screen for trust/intro.
- During product explanation, show product screen recording full-screen and presenter as small PiP.
- Match product footage to the spoken concept (menu, waiter request/status, customization, feedback).
- At personalized_mockup anchor, show the venue-specific app mockup full-screen for 4-6 seconds, then return to presenter for CTA.
- For dashboard/menu-control or management-visibility lines where no dashboard footage exists, prefer presenter full-screen or product footage rather than inventing fake screens.
- Premium, restrained transitions.

Return ONLY JSON:
{{
 "canvas":{{"width":1080,"height":1920,"fps":30}},
 "timeline":[
   {{"start":number,"end":number,"layout":"qr_full"|"presenter_full"|"product_with_pip"|"mockup_full","product_source_start":number|null,"product_source_end":number|null,"reason":string}}
 ],
 "notes":[string]
}}
Cover 0.0 through exactly {talk_duration:.3f} with no gaps or overlaps. Never use product timestamps outside 0..{product_duration:.3f}.
'''
edit_plan = ask(plan_prompt)
(OUT / "edit_plan.json").write_text(
    json.dumps(edit_plan, ensure_ascii=False, indent=2), encoding="utf-8"
)

print(json.dumps({
    "talk_duration": talk_duration,
    "product_duration": product_duration,
    "segments": len(segments),
    "words": len(words),
    "anchors": anchors.get("anchors", []),
}, ensure_ascii=False, indent=2))
