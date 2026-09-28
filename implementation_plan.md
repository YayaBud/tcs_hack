# Implementation Plan: EcoSort — Smart Waste Segregation (local VLM, offline)

40 min, 2 people. Photo of waste → a local vision model (Ollama) names each item + its material → the server maps material → stream/bin/disposal steps from a fixed knowledge base. No API, no cloud, no deploy. Runs on one laptop.

## Decisions (measured, 28 Sep)

- **Model: `qwen3-vl:2b-instruct` (1.9 GB).** Demo laptop = GTX 1650 **4 GB VRAM**, Ryzen 5 4600H, 15 GB RAM. A 2B model fits fully in VRAM, so it's fast.
  - Do NOT pull plain `qwen3-vl:2b`. Its registry digest matches `2b-thinking`, which writes long reasoning and is slow.
  - Backup if quality is poor: `qwen3.5:2b` (2.7 GB). `4b` models (3.3 GB+) are too tight for 4 GB VRAM.
- **Model outputs only `name`, `material`, `recyclable`.** The server derives stream, bin, steps and tip from a fixed table. A small model is reliable on short answers, and the guidance can't be hallucinated.
- **Python stdlib only.** `urllib` → Ollama at `localhost:11434`. Zero pip installs.

## NOW (T0–T5)
- [ ] Install Ollama (ollama.com/download), then run: `ollama pull qwen3-vl:2b-instruct`
- [ ] If the venue Wi-Fi is slow, switch to a phone hotspot.

## Files — one owner each

| File | Owner |
|---|---|
| `server.py`, `static/streams.js` | **B** (backend + model) |
| `static/index.html`, `static/style.css`, `static/app.js`, `static/gemini.js`, `static/config.js` | **A** (frontend + Gemini) |

## Contract: `POST /api/classify`

Request: `{ "image": "<base64 JPEG, no data: prefix>" }`

Response:
```jsonc
{
  "items": [{
    "name": "Plastic bottle",
    "material": "plastic",     // plastic|paper|glass|metal|organic|textile|e-waste|battery|hazardous|other
    "stream": "dry",           // wet|dry|hazardous|e-waste|unknown  (server derives from material)
    "recyclable": true,
    "disposal": ["Empty and rinse", "Dry it, BLUE bin", "Bottles → kabadiwala/recycler"],
    "eco_tip": "Carry a steel bottle — skip single-use plastic."
  }],
  "message": "",               // "No waste item found — try a closer photo" when items is empty
  "model": "qwen3-vl:2b-instruct",
  "ms": 2100                   // measured inference time, shown in UI as "Analysed on-device in 2.1 s"
}
```
Error: `{ "error": "..." }`

## Gemini layer (A, frontend only — no server work for B)

After `/api/classify` returns, the browser sends the items JSON to **Gemini** (`gemini-3.5-flash`, falls back to `gemini-3.5-flash-lite` on 429/5xx), which:
1. **Judges** each item: `verdict: correct|check|wrong`, `suggested_stream`, one-line `note` (structured JSON output) → shown on each card.
2. Writes a 2–3 sentence **summary** → "🧠 AI review" card.
3. Powers **Ask EcoSort** chat, grounded in the last scan + review.

Key lives in `static/config.js` (gitignored; copy `config.example.js`). The classifier stays offline. Gemini needs internet; if it's unreachable, the cards still show and the review says "unavailable".

`static/streams.js` (B): `STREAMS = { wet: {label, bin:'GREEN bin', color, emoji}, dry: {…'BLUE bin'}, hazardous: {…'Separate — never mix'}, 'e-waste': {…'E-waste collector'}, unknown: {…} }` + `LEARN` examples per stream.

## Tasks

**B — server.py (T5–T20)**
- [ ] Use `ThreadingHTTPServer` on `0.0.0.0:8000`; serve `static/`; handle `POST /api/classify`. Reject a body over 10 MB (413) and a missing `image` (400).
- [ ] Ollama call: `POST /api/chat` with `model`, `messages:[{role:user, content:PROMPT, images:[b64]}]`, `format: <JSON schema {items:[{name, material(enum), recyclable}]}>`, `stream:false`, `keep_alive:"60m"`, `options:{temperature:0}`, urllib timeout 120 s.
- [ ] Map `MATERIAL → stream` + `KB[material] → disposal, eco_tip`. An unknown material → `other`/`unknown`.
- [ ] Warm up at startup: send one tiny request so the first demo shot isn't slow. Print the localhost and LAN URLs.
- [ ] Ollama down → 503 `{error:"Start Ollama"}`.

**Prompt:** "List each separate waste item in this photo. For each: short name, main material (plastic, paper, glass, metal, organic = food/plants, textile, e-waste = electronics/chargers/cables, battery, hazardous = medicines/chemicals/paint/bulbs, other), and whether it is commonly recyclable in India. No waste item → empty list."

**A — frontend (T5–T20)**
- [ ] Add a file input (`accept="image/*" capture="environment"`) and resize to a max side of **640 px** (JPEG 0.85) → base64 → POST with a 90 s timeout and a spinner. Use `?mock` for dev and delete it before the demo.
- [ ] Brightness check on the canvas: if it's dark, apply `ctx.filter='brightness(1.4)'` and show a "Low light — auto-brightened" banner. This covers the low-quality-image requirement.
- [ ] Result card: emoji + name, coloured stream chip, "→ BLUE bin", ♻️ yes/no, steps, 💡 tip. Footer: "On-device · qwen3-vl · 2.1 s".
- [ ] Insert model text with `textContent` only.
- [ ] (stretch) Learn section from `LEARN`, localStorage counter, webcam.

## ✅ T20 — merge on the demo laptop, run one real photo end to end
## T20–T30 polish · T30 CODE FREEZE · T30–T40 rehearse

## Test (B, at T20)
Test photos: bottle → dry, banana peel → wet, paper → dry, battery → hazardous, charger → e-waste, 3 items in one shot → 3 cards, selfie → empty + message. Record `ms` for each photo.

## Demo (2 min)
Problem → snap bottle (BLUE bin) → banana peel (GREEN) → battery (hazardous) → multi-item shot → dark photo auto-brightened → point at "runs fully offline, 2 s, no data leaves the laptop."
