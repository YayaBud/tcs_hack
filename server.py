"""EcoSort backend.

Pipeline: photo -> local VLM (Ollama, fast raw description) -> Gemini judge (reads the raw
text, returns structured verdict) -> response. If Gemini is unavailable (no key / offline),
falls back to the local VLM with a JSON schema.

Run:  $env:GEMINI_API_KEY="..."; python server.py      (stdlib only)
"""
import json, os, socket, time, urllib.request, urllib.error
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

VLM_MODEL = os.environ.get("ECOSORT_VLM", "qwen3-vl:2b-instruct")
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")  # 3.7-flash was 503/overloaded on 28 Sep; lite answered in 2.2 s
_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gemini_key.txt")  # gitignored
GEMINI_KEY = os.environ.get("GEMINI_API_KEY") or (
    open(_KEY_FILE).read().strip() if os.path.exists(_KEY_FILE) else "")
PORT = int(os.environ.get("PORT", 8000))
MAX_BODY = 10_000_000

MATERIALS = ["plastic", "paper", "glass", "metal", "organic", "textile",
             "e-waste", "battery", "hazardous", "other"]
STREAM = {"organic": "wet", "plastic": "dry", "paper": "dry", "glass": "dry", "metal": "dry",
          "textile": "dry", "e-waste": "e-waste", "battery": "hazardous",
          "hazardous": "hazardous", "other": "unknown"}
# Fixed guidance per material: used when the judge gives none, and for the offline fallback.
KB = {
    "organic": (["Put in the GREEN (wet) bin", "No plastic bags inside - wrap in newspaper if needed",
                 "Compost at home or in the hostel compost pit"],
                "Composted food waste becomes fertiliser instead of rotting in a landfill."),
    "plastic": (["Empty and rinse", "Dry it, then BLUE (dry) bin",
                 "Bottles and hard plastics -> kabadiwala / recycler"],
                "Carry a steel bottle - skip single-use plastic."),
    "paper": (["Keep it clean and dry", "Flatten boxes", "BLUE bin or sell to kabadiwala"],
              "Food-soiled paper can't be recycled - compost it instead."),
    "glass": (["Rinse it", "Wrap broken glass in newspaper and label it", "BLUE bin / kabadiwala"],
              "Glass can be recycled again and again without losing quality."),
    "metal": (["Rinse cans", "Crush to save space", "BLUE bin / kabadiwala - metal has resale value"],
              "Aluminium cans can be recycled into new cans."),
    "textile": (["Donate if still wearable", "Otherwise keep dry and put in dry waste / textile collection"],
                "Old clothes make good cleaning rags before they become waste."),
    "e-waste": (["Never put in a household bin", "Hand to an authorised e-waste collector or brand take-back",
                 "Wipe personal data from phones and laptops first"],
                "E-waste holds toxic metals and recoverable copper and gold - never burn or break it."),
    "battery": (["Never throw in a household bin", "Tape the terminals",
                 "Drop at a battery / e-waste collection point"],
                "Damaged batteries can leak chemicals and start fires in garbage trucks."),
    "hazardous": (["Keep separate in a sealed, labelled bag", "Hand to hazardous-waste collection",
                   "Expired medicines -> pharmacy take-back where available"],
                  "Never pour chemicals or medicines down the drain."),
    "other": (["Keep it separate if unsure", "Check your local collection rules"],
              "When in doubt, keep it out of the recycling bin - contamination spoils whole batches."),
}

VLM_PROMPT = ("Look at this photo and list every object that could be waste. For each object write one "
              "line: what it is, what it is made of, and its condition (clean, dirty, broken, food-soiled). "
              "Be short and factual. If there is nothing that could be waste, say 'no waste'.")
MAT_LIST = ("plastic, paper, glass, metal, organic = food/plants, textile, e-waste = electronics/chargers/"
            "cables, battery, hazardous = medicines/chemicals/paint/bulbs, other")
JUDGE_PROMPT = ("You are a waste-segregation expert for India (Swachh Bharat: GREEN bin = wet, BLUE bin = dry; "
                "hazardous and e-waste kept separate). A small vision model looked at a user's photo and wrote "
                "this raw description:\n---\n{raw}\n---\nThe photo is attached. Trust the photo over the description: "
                "correct mistakes, add items it missed, merge duplicates, drop things that are not waste. "
                "If the photo is blurry, dark or low quality, still give your best guess from shape and colour. For each waste item give: short name, material (one of: "
                f"{MAT_LIST}), whether it is commonly recyclable in India, 2-4 short practical disposal steps, "
                "and one short educational eco tip (no invented statistics, never suggest burning). "
                "If there is no waste, return an empty items list.")
LOCAL_PROMPT = ("List each separate waste item in this photo. For each: short name, main material "
                f"({MAT_LIST}), and whether it is commonly recyclable in India. No waste -> empty list.")

LOCAL_SCHEMA = {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "items": {
    "type": "object", "required": ["name", "material", "recyclable"], "properties": {
        "name": {"type": "string"}, "material": {"type": "string", "enum": MATERIALS},
        "recyclable": {"type": "boolean"}}}}}}
JUDGE_SCHEMA = {"type": "OBJECT", "required": ["items"], "properties": {"items": {"type": "ARRAY", "items": {
    "type": "OBJECT", "required": ["name", "material", "recyclable", "disposal", "eco_tip"], "properties": {
        "name": {"type": "STRING"}, "material": {"type": "STRING", "enum": MATERIALS},
        "recyclable": {"type": "BOOLEAN"}, "disposal": {"type": "ARRAY", "items": {"type": "STRING"}},
        "eco_tip": {"type": "STRING"}}}}}}


def post_json(url, body, headers=None, timeout=120):
    req = urllib.request.Request(url, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ollama(prompt, images, schema=None, max_tokens=200):
    body = {"model": VLM_MODEL, "stream": False, "keep_alive": "60m",
            # num_ctx 2048: keeps the 2B model 100% on the 4 GB GTX 1650 (4096 spilled 18% to CPU)
            "options": {"temperature": 0, "num_predict": max_tokens, "num_ctx": 2048},
            "messages": [{"role": "user", "content": prompt, "images": images}]}
    if schema:
        body["format"] = schema
    return post_json(f"{OLLAMA}/api/chat", body)["message"]["content"]


def gemini_judge(raw, image_b64):
    # Judge sees the photo too: fixes the small model's misses on blurry / dark / cluttered shots.
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
                                    {"text": JUDGE_PROMPT.format(raw=raw)}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                                 "responseSchema": JUDGE_SCHEMA}}
    res = post_json(url, body, {"x-goog-api-key": GEMINI_KEY}, timeout=30)
    return json.loads(res["candidates"][0]["content"]["parts"][0]["text"])


def normalise(items):
    out = []
    for it in items or []:
        mat = it.get("material") if it.get("material") in KB else "other"
        steps, tip = KB[mat]
        disposal = [str(s)[:160] for s in (it.get("disposal") or []) if str(s).strip()][:4] or steps
        out.append({"name": str(it.get("name") or "Item")[:80], "material": mat, "stream": STREAM[mat],
                    "recyclable": bool(it.get("recyclable")), "disposal": disposal,
                    "eco_tip": str(it.get("eco_tip") or tip)[:200]})
    return out


def classify(image_b64):
    t0 = time.perf_counter()
    raw = ollama(VLM_PROMPT, [image_b64], max_tokens=120).strip()
    t1 = time.perf_counter()
    judge, note = GEMINI_MODEL, ""
    try:
        if not GEMINI_KEY:
            raise RuntimeError("GEMINI_API_KEY not set")
        try:
            items = gemini_judge(raw, image_b64)["items"]
        except Exception:  # one retry: Gemini blips with 503 under load
            items = gemini_judge(raw, image_b64)["items"]
    except Exception as e:  # offline / no key / bad reply -> local-only verdict
        judge, note = "local", f"Judge unavailable ({type(e).__name__}: {str(e)[:120]}); local model only."
        try:
            items = json.loads(ollama(LOCAL_PROMPT, [image_b64], LOCAL_SCHEMA, 800)).get("items", [])[:8]
        except json.JSONDecodeError:  # small model ran out of tokens on a busy photo
            items, note = [], note + " Photo too busy for offline mode - try fewer items."
    t2 = time.perf_counter()
    items = normalise(items)
    return {"items": items, "message": "" if items else "No waste item found - try a closer photo.",
            "raw": raw, "model": VLM_MODEL, "vlm": VLM_MODEL, "judge": judge, "note": note,
            "ms": round((t2 - t0) * 1000),  # frontend reads a number
            "timing": {"vlm": round((t1 - t0) * 1000), "judge": round((t2 - t1) * 1000)}}


class Handler(SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/api/health":
            return super().do_GET()
        h = {"vlm": VLM_MODEL, "vlm_ok": False, "judge": GEMINI_MODEL, "judge_ok": False}
        try:
            with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=3) as r:
                h["vlm_ok"] = any(m["name"] == VLM_MODEL for m in json.loads(r.read())["models"])
        except Exception:
            pass
        if GEMINI_KEY:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}"
                urllib.request.urlopen(urllib.request.Request(url, headers={"x-goog-api-key": GEMINI_KEY}), timeout=5)
                h["judge_ok"] = True
            except Exception:
                pass
        self._json(200, h)

    def do_POST(self):
        if self.path != "/api/classify":
            return self._json(404, {"error": "Not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "Image too large"})
        try:
            image = json.loads(self.rfile.read(n) or b"{}").get("image")
        except (json.JSONDecodeError, AttributeError):
            return self._json(400, {"error": "Body must be JSON"})
        if not isinstance(image, str) or not image:
            return self._json(400, {"error": "Missing 'image' (base64)"})
        image = image.split(",", 1)[-1] if image.startswith("data:") else image
        try:
            self._json(200, classify(image))
        except urllib.error.HTTPError as e:
            self._json(502, {"error": f"Local model error {e.code}: {e.read().decode(errors='replace')[:200]}"})
        except urllib.error.URLError as e:
            self._json(503, {"error": f"Local model unavailable - is Ollama running? ({e.reason})"})
        except Exception as e:
            self._json(502, {"error": f"Model error: {e}"})


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "?"


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    static = os.path.join(here, "static")
    os.makedirs(static, exist_ok=True)
    try:  # load the VLM into VRAM now so the first demo shot is fast
        t = time.perf_counter()
        post_json(f"{OLLAMA}/api/generate", {"model": VLM_MODEL, "prompt": "", "keep_alive": "60m"})
        print(f"VLM {VLM_MODEL} loaded in {time.perf_counter() - t:.1f}s")
    except Exception as e:
        print(f"WARNING: could not load {VLM_MODEL} ({e}). Is Ollama running?")
    print(f"Judge: {GEMINI_MODEL}" if GEMINI_KEY else "Judge: OFF (set GEMINI_API_KEY) - local-only mode")
    print(f"EcoSort: http://localhost:{PORT}  |  phone: http://{lan_ip()}:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), partial(Handler, directory=static)).serve_forever()
