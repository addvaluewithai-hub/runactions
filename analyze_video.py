import json
import os
import re
import time
from pathlib import Path

from google import genai

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set")

client = genai.Client(api_key=API_KEY)
OUT = Path("out")
OUT.mkdir(exist_ok=True)


def upload_and_wait(path: str):
    f = client.files.upload(file=path)
    while True:
        f = client.files.get(name=f.name)
        state = getattr(getattr(f, "state", None), "name", str(getattr(f, "state", "")))
        if state == "ACTIVE":
            return f
        if state == "FAILED":
            raise RuntimeError(f"Gemini file processing failed for {path}")
        time.sleep(3)


def clean_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def ask(contents, prompt: str):
    response = client.models.generate_content(
        model=MODEL,
        contents=[*contents, prompt],
        config={"temperature": 0.1, "response_mime_type": "application/json"},
    )
    return clean_json(response.text)


talk_path = os.getenv("TALK_VIDEO", "talk.mp4")
product_path = os.getenv("PRODUCT_VIDEO", "product.mp4")

talk = upload_and_wait(talk_path)
product = upload_and_wait(product_path)

transcript_prompt = r'''
You are a precision Arabic video transcript editor. Analyze this vertical selfie sales video. The speaker is Egyptian Arabic and may mix English product terms.

Return ONLY valid JSON with this shape:
{
  "duration_seconds": number,
  "language": "Egyptian Arabic",
  "segments": [
    {"start": number, "end": number, "text": string, "intent": string}
  ],
  "anchors": [
    {"id": string, "start": number, "end": number, "quote": string, "confidence": number, "visual_recommendation": string}
  ]
}

Rules:
- Transcribe the speech VERBATIM in Arabic as spoken; keep English product words in Latin letters when spoken in English.
- Use short natural speech segments, normally 1-5 seconds each.
- Give start/end timestamps in SECONDS with one decimal place. Align to the AUDIO, not only visual frames. Avoid overlaps.
- Do not invent words. If a word is uncertain, write the most likely word and lower confidence only on the relevant anchor.
- Preserve the speaker's conversational Egyptian phrasing.
- Identify useful edit anchors when they occur. Use these IDs only when supported by the actual speech: qr_intro, problem_context, qserve_intro, personalized_mockup, digital_menu, order_from_table, call_waiter, dashboard, analytics, customization, closing_cta.
- The anchor personalized_mockup is specifically the moment where he says something equivalent to: "وده شكل تخيلي لـ QServe مناسب للمكان عندكم" or clearly introduces a customized visual/example for this venue.
- visual_recommendation should be concise and practical for a sales video editor.
'''

product_prompt = r'''
Analyze this vertical mobile screen recording of the QServe product demo. Return ONLY valid JSON:
{
  "duration_seconds": number,
  "shots": [
    {"start": number, "end": number, "label": string, "description": string, "quality": "great"|"usable"|"avoid"}
  ]
}

Rules:
- Use timestamps in seconds with one decimal place.
- Break the recording into stable, useful visual ranges for editing.
- Prefer intervals where the screen is readable and not mid-transition.
- Use labels from this list when applicable: home, menu_home, menu_scroll, category_browse, arabic_menu, language_switch, waiter_request, request_status, request_complete, feedback, other.
- Describe what is visibly happening. Do not infer backend behavior.
'''

transcript = ask([talk], transcript_prompt)
product_shots = ask([product], product_prompt)

edit_prompt = f'''
You are planning a polished vertical 9:16 personalized outbound sales video for a restaurant lead.

PRIMARY TALKING VIDEO transcript/anchors:\n{json.dumps(transcript, ensure_ascii=False)}

PRODUCT SCREEN RECORDING shots:\n{json.dumps(product_shots, ensure_ascii=False)}

Editing brief:
- Final canvas 1080x1920 vertical.
- Keep the original talking-video audio as the master narration.
- Opening: show the personalized tabletop QR image full-screen briefly, then reveal the presenter.
- During explanation of the product, transition to the product screen recording full-screen with the presenter's talking head reduced to a small rounded picture-in-picture bubble/rectangle.
- At the exact personalized_mockup phrase, show a personalized app mockup image for this venue prominently.
- Choose product screen ranges that match what the presenter is saying: menu, order from table, call waiter, request state, etc.
- Use the presenter full-screen for trust-building/personal sections and the closing CTA.
- Avoid over-editing. Premium restaurant aesthetic, clean transitions, no cheesy effects.
- Do NOT add a bill/request-bill feature callout unless the speech explicitly requires it.
- This first lead is Rooftop 7000.

Return ONLY valid JSON:
{{
  "canvas": {{"width":1080,"height":1920,"fps":30}},
  "timeline": [
    {{
      "start": number,
      "end": number,
      "layout": "qr_full"|"presenter_full"|"product_with_pip"|"mockup_full"|"mockup_with_pip",
      "product_source_start": number|null,
      "product_source_end": number|null,
      "reason": string
    }}
  ],
  "notes": [string]
}}

Use the talk video's original timeline as the master timebase. Cover it continuously from 0.0 to the end. Product source ranges can be reused or time-stretched slightly only if visually safe.
'''

edit_plan = ask([], edit_prompt)

for name, data in [("transcript.json", transcript), ("product_shots.json", product_shots), ("edit_plan.json", edit_plan)]:
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

summary = {
    "model": MODEL,
    "talk_video": talk_path,
    "product_video": product_path,
    "anchors": transcript.get("anchors", []),
    "timeline_count": len(edit_plan.get("timeline", [])),
}
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=2))
