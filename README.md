# EcoSort — Smart Waste Segregation Assistant

Point a camera at any piece of waste. EcoSort names each item, says which bin it goes in, whether it is recyclable, how to prepare it for disposal, and why. Built for Indian households: **green bin = wet, blue bin = dry** (Swachh Bharat), with hazardous waste and e-waste kept separate.

Tech Day @ Amity, Noida — 28 Sep 2026.

## How it meets the problem statement

| Requirement | What EcoSort does |
|---|---|
| Upload or capture waste images | Phone camera (`capture="environment"`), file upload, drag and drop, paste. **Try on phone** shows a QR code / address for any phone on the same Wi-Fi. |
| Category of waste | Wet, dry, domestic hazardous or e-waste, plus the material (plastic, paper, glass, metal, organic, textile, battery, …). Several items in one photo are listed separately. |
| Recyclable vs non-recyclable | Every item is marked recyclable or not, with a one-line reason. |
| Appropriate disposal methods | 2–4 practical preparation steps per item (rinse, flatten, tape battery terminals, kabadiwala / e-waste collector). |
| Low-quality mobile images | Photos are resized to 640 px in the browser (fast upload), dark photos are auto-brightened, and the judge sees the photo itself, so blurry shots still classify. The app says when a photo was blurry, dark or cluttered and how to retake it. |
| Fast image processing | Small local vision model plus a fast Gemini Flash-Lite judge; the model is loaded and warmed up when the server starts. Measured timings below. |
| Environmental awareness, simple and educational | Learn panel for the four streams, an eco tip per item, **Read aloud**, answers in **Hindi** (हिन्दी), impact counters, and an *Ask EcoSort* chat for follow-up questions. |

## Architecture

```
 phone / laptop browser                 server.py (Python stdlib, this laptop)
 ─────────────────────                  ─────────────────────────────────────
 resize ≤640 px, brighten if dark ──►  POST /api/classify {image, lang}
                                          │
                                          ├─ 1. qwen3-vl:2b-instruct via Ollama (on-device GPU)
                                          │     writes a short raw description of the photo
                                          │
                                          ├─ 2. Gemini 3.5 Flash-Lite judge (photo + raw description)
                                          │     corrects / completes it → items, material, recyclable,
                                          │     steps, tip, reason, photo quality  (Hindi on request)
                                          │     one retry on a 503
                                          │
                                          └─ offline / no key: local model answers alone, with steps and
                                                tips from a fixed table in server.py
 cards, bins, read aloud  ◄──────────  JSON
 Gemini second-opinion review and the Ask EcoSort chat run in the browser (static/gemini.js).
```

Stream and bin are derived from the material by a fixed table on the server, so the same material always lands in the same bin.

## Measured on the dev laptop (GTX 1650 4 GB, Ryzen 5 4600H)

| Case | On-device vision | Gemini judge |
|---|---|---|
| New photo (any size 256–640 px) | 13–15 s | 2.2–5.9 s |
| Same photo again (Ollama cache) | ~0.6 s | ~2–3 s |

Ollama's timing for one new photo: 1,073 prompt tokens (mostly image) processed in 12.5 s; the reply itself (24 tokens) took 0.3 s. Qwen3-VL pads small images up to a minimum size, which is why shrinking photos does not speed it up on this GPU. A stronger GPU shortens the vision step; the judge time is network-bound.

Blurry-photo check: a bottle photo shrunk to 24 px and enlarged back was still classified as a plastic bottle (dry, recyclable), and the photo was flagged `blurry` with a retake tip.

## Run it

1. Install [Ollama](https://ollama.com/download), then `ollama pull qwen3-vl:2b-instruct` (1.9 GB).
2. Gemini key (from aistudio.google.com):
   - server judge: put the key in `gemini_key.txt` in the project root, or set `$env:GEMINI_API_KEY`;
   - browser review and chat: copy `static/config.example.js` to `static/config.js` and paste the key.
   Both files are gitignored. Without a key, EcoSort runs fully offline on the local model.
3. `python server.py` → open http://localhost:8000. The startup log prints the phone address.

Optional environment variables: `ECOSORT_VLM` (default `qwen3-vl:2b-instruct`), `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), `OLLAMA_URL`, `PORT` (default 8000).

## Files

| File | Role |
|---|---|
| `server.py` | Serves `static/`, `POST /api/classify` (VLM → judge → fallback), `GET /api/health` (model status + phone URL) |
| `static/index.html`, `style.css`, `app.js` | Scan station, result cards, Hindi toggle, read aloud, try-on-phone, stats |
| `static/gemini.js` | Browser-side Gemini second opinion and the Ask EcoSort chat |
| `static/streams.js` | Stream labels, bins and Learn examples |

## Privacy

The photo is resized in the browser and read by the local model first. When online, a resized copy goes to Gemini to double-check the result. Nothing is stored on the server; the counters live in your browser.

## Known limits

- On a 4 GB GPU the local model needs about 13 s per new photo; the Gemini judge adds 2–6 s.
- Cluttered scenes may merge similar items (the app flags these photos as "cluttered").
- Hindi answers need the online judge; the offline fallback answers in English.
- Read aloud in Hindi needs a Hindi voice in the browser (Chrome and Edge include one).
- Bin colours for hazardous waste and e-waste vary by city, so EcoSort says "keep separate" instead of naming a colour.
