// EcoSort frontend (owner: A). Model/server text is only ever inserted via textContent.
'use strict';

const MOCK = new URLSearchParams(location.search).has('mock'); // dev only, remove before demo
const MAX_SIDE = 640;
const JPEG_QUALITY = 0.85;
const CLASSIFY_TIMEOUT_MS = 90_000;
const DARK_THRESHOLD = 80; // mean luma 0-255

const STREAM_ICONS = { wet: 'ph-leaf', dry: 'ph-recycle', hazardous: 'ph-warning', 'e-waste': 'ph-plug', unknown: 'ph-question' };
const VERDICTS = {
  correct: { icon: 'ph-check-circle', label: 'Gemini agrees.' },
  check:   { icon: 'ph-warning-circle', label: 'Double-check.' },
  wrong:   { icon: 'ph-x-circle', label: 'Gemini disagrees.' },
};

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file'), dropzone: $('dropzone'), preview: $('preview'), lowlight: $('lowlight'),
  newPhoto: $('new-photo'), status: $('status'), error: $('error'), emptyState: $('empty-state'),
  results: $('results'), message: $('message'), footer: $('footer'), resultsPanel: $('results-panel'),
  tpl: $('item-tpl'), chat: $('chat'), askForm: $('ask-form'), askInput: $('ask-input'),
  suggestions: $('suggestions'), learnGrid: $('learn-grid'), count: $('count'),
  mockBadge: $('mock-badge'), llmStatus: $('llm-status'),
  review: $('review'), reviewText: $('review-text'), reviewMeta: $('review-meta'),
  scanState: $('scan-state'), modelTime: $('model-time'),
  diverted: $('metric-diverted'), lastTime: $('metric-time'),
  quality: $('quality'), speak: $('speak'), langToggle: $('lang-toggle'),
  phoneBtn: $('phone-btn'), phoneDlg: $('phone-dlg'), phoneUrl: $('phone-url'), phoneQr: $('phone-qr'),
};

// Hindi mode: the server judge writes item text in Hindi; bins/labels are translated here.
const HI = {
  label: { wet: 'गीला कचरा', dry: 'सूखा कचरा', hazardous: 'हानिकारक कचरा', 'e-waste': 'ई-कचरा', unknown: 'पता नहीं' },
  bin: { wet: 'हरा डिब्बा', dry: 'नीला डिब्बा', hazardous: 'अलग रखें, मिलाएँ नहीं', 'e-waste': 'ई-कचरा संग्रहकर्ता', unknown: 'स्थानीय संग्रहकर्ता से पूछें' },
  yes: 'रीसायकल योग्य', no: 'रीसायकल योग्य नहीं',
};
const QUALITY = { // [icon, English, Hindi]
  blurry: ['ph-drop', 'Blurry photo, analysed anyway.', 'धुंधली फ़ोटो, फिर भी जाँची गई।'],
  dark: ['ph-moon', 'Dark photo, analysed anyway.', 'अँधेरी फ़ोटो, फिर भी जाँची गई।'],
  cluttered: ['ph-stack', 'Busy photo, some items may be merged.', 'बहुत सारी चीज़ें, कुछ छूट सकती हैं।'],
};
let lang = (() => { try { return localStorage.getItem('ecosort-lang') === 'hi' ? 'hi' : 'en'; } catch { return 'en'; } })();
let lastB64 = null; // last prepared photo, re-used when the language is switched
const recText = (yes) => (lang === 'hi' ? (yes ? HI.yes : HI.no) : (yes ? 'Recyclable' : 'Not recyclable'));

let lastItems = [];     // classifier output, context for Gemini
let lastReview = null;  // Gemini's judgement of lastItems
let scanId = 0;         // ignore stale responses if a new photo is taken mid-request

// ---------- Image: resize + low-light fix ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image. Try a JPG or PNG.')); };
    img.src = url;
  });
}

function meanLuma(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  const step = 4 * 8; // sample every 8th pixel
  for (let i = 0; i < data.length; i += step) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / step);
}

/** Draws the image (max side 640) to the preview canvas, brightens if dark, returns base64 JPEG (no prefix). */
function prepareImage(img) {
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = el.preview;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.filter = 'none';
  ctx.drawImage(img, 0, 0, w, h);
  const dark = meanLuma(ctx, w, h) < DARK_THRESHOLD;
  if (dark) {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = 'brightness(1.4)';
    ctx.drawImage(img, 0, 0, w, h);
    ctx.filter = 'none';
  }
  el.lowlight.hidden = !dark;
  canvas.hidden = false;
  el.dropzone.classList.add('has-image');

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
}

// ---------- API ----------

async function postJSON(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The classifier timed out. Is Ollama running?');
    if (err instanceof TypeError) throw new Error('Cannot reach the EcoSort server. Is server.py running?');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function classify(b64) {
  return MOCK ? mockClassify() : postJSON('/api/classify', { image: b64, lang }, CLASSIFY_TIMEOUT_MS);
}

function reviewScan(data) {
  return MOCK ? mockReview(data) : Gemini.review(data);
}

function askInsight(question) {
  const context = {
    items: lastItems.map(({ name, material, stream, recyclable }) => ({ name, material, stream, recyclable })),
    review: lastReview && { summary: lastReview.summary, items: lastReview.items },
  };
  return MOCK ? mockInsight(question) : Gemini.ask(question, context);
}

const llmReady = () => MOCK || Gemini.enabled();

// ---------- Rendering ----------

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

function setLoading(on) {
  el.status.hidden = !on;
  el.dropzone.classList.toggle('scanning', on);
  el.dropzone.setAttribute('aria-busy', String(on));
  el.scanState.querySelector('.dot').className = `dot ${on ? 'busy' : 'ok'}`;
  el.scanState.querySelector('.scan-label').textContent = on ? 'Analysing' : 'Ready';
  if (on) el.emptyState.hidden = true;
}

function showError(text) {
  el.error.textContent = text || '';
  el.error.hidden = !text;
}

function streamInfo(stream) {
  const key = STREAMS[stream] ? stream : 'unknown';
  const s = { key, ...STREAMS[key] };
  if (lang === 'hi') { s.label = HI.label[key]; s.bin = HI.bin[key]; }
  return s;
}

function setIcon(i, name) {
  i.className = `ph ${name}`;
}

function renderItem(item, index) {
  const node = el.tpl.content.firstElementChild.cloneNode(true);
  const s = streamInfo(item.stream);
  node.dataset.stream = s.key;
  node.style.setProperty('--i', index);
  setIcon(node.querySelector('.item-icon .ph'), STREAM_ICONS[s.key]);
  node.querySelector('.name').textContent = item.name;
  node.querySelector('.material').textContent = item.material || '';
  node.querySelector('.bin').textContent = s.bin;
  node.querySelector('.stream').textContent = s.label;

  const rec = node.querySelector('.recyclable');
  rec.classList.toggle('yes', Boolean(item.recyclable));
  const recIcon = document.createElement('i');
  recIcon.setAttribute('aria-hidden', 'true');
  setIcon(recIcon, item.recyclable ? 'ph-recycle' : 'ph-trash');
  rec.append(recIcon, recText(item.recyclable));

  const why = node.querySelector('.why');
  node.querySelector('.why-text').textContent = item.reason || '';
  why.hidden = !item.reason;

  const steps = node.querySelector('.steps');
  for (const step of item.disposal || []) {
    const li = document.createElement('li');
    li.textContent = step;
    steps.appendChild(li);
  }
  node.querySelector('.prep').hidden = !steps.children.length;

  const tip = node.querySelector('.tip');
  node.querySelector('.tip-text').textContent = item.eco_tip || '';
  tip.hidden = !item.eco_tip;
  return node;
}

function renderResults(data) {
  const items = data.items || [];
  el.results.replaceChildren(...items.map(renderItem));
  el.message.textContent = items.length ? '' : (data.message || 'No waste item found. Try a closer, well-lit photo.');
  el.message.hidden = items.length > 0;
  const q = QUALITY[data.quality];
  el.quality.hidden = !q;
  if (q) {
    setIcon(el.quality.querySelector('.ph'), q[0]);
    el.quality.querySelector('.quality-text').textContent = `${q[lang === 'hi' ? 2 : 1]} ${data.quality_tip || ''}`.trim();
  }
  el.speak.hidden = !items.length || !('speechSynthesis' in window);
  if (data.ms != null) {
    const model = (data.model || 'local model').split(':')[0];
    el.footer.textContent = `Last scan: ${model} on-device, ${secs(data.ms)}`;
    el.footer.hidden = false;
    el.modelTime.textContent = secs(data.ms);
    el.modelTime.hidden = false;
    el.lastTime.textContent = secs(data.ms);
  }
  lastItems = items;
  lastReview = null;
  renderSuggestions();
  if (items.length) bumpStats(items);
}

// ---------- Gemini review of the classifier output ----------

async function runReview(data, id) {
  if (!data.items?.length || !llmReady()) { el.review.hidden = true; return; }
  el.review.hidden = false;
  el.review.classList.add('loading');
  el.reviewText.textContent = 'Checking the classification...';
  el.reviewMeta.textContent = '';
  try {
    const review = await reviewScan(data);
    if (id !== scanId) return;
    lastReview = review;
    el.reviewText.textContent = review.summary;
    el.reviewMeta.textContent = `${review.model}, ${secs(review.ms)}`;
    applyVerdicts(review.items || []);
    renderSuggestions();
    setLlmStatus(MOCK ? 'mock' : 'ok');
  } catch (err) {
    if (id !== scanId) return;
    el.reviewText.textContent = `Review unavailable. ${err.message}`;
    setLlmStatus('off');
  } finally {
    if (id === scanId) el.review.classList.remove('loading');
  }
}

function applyVerdicts(verdicts) {
  const cards = el.results.querySelectorAll('.item');
  for (const v of verdicts) {
    const card = cards[v.index];
    const item = lastItems[v.index];
    const meta = VERDICTS[v.verdict];
    if (!card || !item || !meta) continue;
    const p = card.querySelector('.verdict');
    p.className = `verdict ${v.verdict}`;
    setIcon(p.querySelector('.ph'), meta.icon);
    let text = `${meta.label} ${v.note}`;
    if (v.suggested_stream && v.suggested_stream !== item.stream) {
      const s = streamInfo(v.suggested_stream);
      text += ` Suggested: ${s.label}, ${s.bin}.`;
    }
    p.querySelector('.verdict-text').textContent = text;
    p.hidden = false;
  }
}

function setLlmStatus(state) {
  const dot = el.llmStatus.querySelector('.dot');
  const label = el.llmStatus.querySelector('.status-label');
  const states = {
    ok: ['ok', 'Gemini online'],
    off: ['off', 'Gemini offline'],
    nokey: ['warn', 'Gemini: add key'],
    mock: ['warn', 'Gemini mocked'],
  };
  const [cls, text] = states[state];
  dot.className = `dot ${cls}`;
  label.textContent = text;
}

function initLlmStatus() {
  if (MOCK) return setLlmStatus('mock');
  if (!Gemini.enabled()) return setLlmStatus('nokey');
  setLlmStatus(navigator.onLine ? 'ok' : 'off');
  addEventListener('online', () => setLlmStatus('ok'));
  addEventListener('offline', () => setLlmStatus('off'));
}

// ---------- Natural-language insight (chat) ----------

function suggestionsFor(items) {
  if (!items.length) {
    return ['How do I start segregating at home?', 'What goes in the green bin?', 'Where do old batteries go?'];
  }
  const first = items[0].name.toLowerCase();
  return [
    `Why does the ${first} go there?`,
    `Can I reuse the ${first}?`,
    items.length > 1 ? 'Summarise what to do with all of these' : 'What should I avoid mixing it with?',
  ];
}

function renderSuggestions() {
  el.suggestions.replaceChildren(...suggestionsFor(lastItems).map((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => ask(q));
    return b;
  }));
}

function addMsg(role, text, meta) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  if (meta) {
    const small = document.createElement('small');
    small.textContent = meta;
    div.appendChild(small);
  }
  el.chat.appendChild(div);
  el.chat.scrollTop = el.chat.scrollHeight;
  return div;
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  if (!llmReady()) {
    addMsg('bot', 'Add a Gemini API key to static/config.js to turn on Ask EcoSort.');
    return;
  }
  addMsg('user', question);
  el.askInput.value = '';
  const pending = addMsg('bot pending', 'Thinking...');
  const submit = el.askForm.querySelector('button');
  submit.disabled = true;
  try {
    const data = await askInsight(question);
    pending.remove();
    addMsg('bot', data.answer || 'No answer.', data.ms != null ? `${data.model}, ${secs(data.ms)}` : '');
    setLlmStatus(MOCK ? 'mock' : 'ok');
  } catch (err) {
    pending.remove();
    addMsg('bot', err.message);
  } finally {
    submit.disabled = false;
  }
}

// ---------- Bin guide + counter ----------

function readStat(key) {
  try { return Number(localStorage.getItem(`ecosort.${key}`)) || 0; } catch { return 0; }
}

function writeStat(key, value) {
  try { localStorage.setItem(`ecosort.${key}`, String(value)); } catch { /* storage unavailable */ }
}

function renderStats() {
  el.count.textContent = readStat('count');
  el.diverted.textContent = readStat('diverted');
}

/** Counts every item, and those kept out of landfill (recyclable or compostable). */
function bumpStats(items) {
  writeStat('count', readStat('count') + items.length);
  writeStat('diverted', readStat('diverted') + items.filter((i) => i.recyclable || i.stream === 'wet').length);
  renderStats();
}

function renderLearn() {
  renderStats();
  if (typeof LEARN === 'undefined') return;
  el.learnGrid.replaceChildren(...Object.entries(LEARN).map(([stream, examples]) => {
    const s = streamInfo(stream);
    const li = document.createElement('li');
    li.className = 'guide-item';
    li.dataset.stream = s.key;
    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, STREAM_ICONS[s.key]);
    const title = document.createElement('strong');
    title.textContent = s.label;
    const bin = document.createElement('span');
    bin.className = 'guide-bin';
    bin.textContent = s.bin;
    const ex = document.createElement('span');
    ex.className = 'guide-ex';
    ex.textContent = examples.slice(0, 3).join(', ');
    li.append(icon, title, bin, ex);
    return li;
  }));
}

// ---------- Mocks (dev only, delete before demo) ----------

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function mockClassify() {
  await delay(1200);
  return {
    items: [
      { name: 'Plastic bottle', material: 'plastic', stream: 'dry', recyclable: true,
        disposal: ['Empty and rinse it', 'Let it dry, then put it in the BLUE bin', 'Or give bottles to a kabadiwala'],
        eco_tip: 'Carry a steel bottle and skip single-use plastic.' },
      { name: 'Banana peel', material: 'organic', stream: 'wet', recyclable: false,
        disposal: ['Put it in the GREEN bin', 'Or compost it at home'],
        eco_tip: 'Peels break down into compost in about a month.' },
      { name: 'AA battery', material: 'battery', stream: 'hazardous', recyclable: true,
        disposal: ['Tape over the terminals', 'Keep it out of household bins', 'Drop it at a battery collection point'],
        eco_tip: 'Rechargeable batteries cut this waste down a lot.' },
    ],
    message: '',
    model: 'qwen3-vl:2b-instruct',
    ms: 2140,
  };
}

async function mockReview(data) {
  await delay(900);
  return {
    summary: 'Rinse the bottle and put it in the BLUE bin, the peel goes in the GREEN bin, ' +
             'and keep the battery separate for a hazardous-waste drop-off.',
    items: data.items.map((it, index) => ({
      index,
      verdict: it.material === 'battery' ? 'check' : 'correct',
      suggested_stream: it.stream,
      note: it.material === 'battery' ? 'Some cities collect batteries with e-waste, so check locally.' : 'Looks right.',
    })),
    model: 'gemini (mock)',
    ms: 900,
  };
}

async function mockInsight(question) {
  await delay(700);
  const names = lastItems.map((i) => i.name).join(', ') || 'nothing scanned yet';
  return {
    answer: `Mock answer to "${question}". Last scan: ${names}. The real answer comes from Gemini.`,
    model: 'gemini (mock)',
    ms: 700,
  };
}

// ---------- Wire-up ----------

async function handleFile(file, reuseB64) {
  if (!file && !reuseB64) return;
  if (file && !file.type.startsWith('image/')) { showError('That file is not an image. Try a JPG or PNG.'); return; }
  const id = ++scanId;
  showError('');
  el.results.replaceChildren();
  el.message.hidden = true;
  el.footer.hidden = true;
  el.review.hidden = true;
  el.quality.hidden = true;
  el.speak.hidden = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  setLoading(true);
  if (matchMedia('(max-width: 900px)').matches) el.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let data;
  try {
    const b64 = reuseB64 || prepareImage(await loadImage(file));
    lastB64 = b64;
    data = await classify(b64);
    if (id !== scanId) return;
    renderResults(data);
  } catch (err) {
    if (id === scanId) { showError(err.message); el.emptyState.hidden = lastItems.length > 0; }
    return;
  } finally {
    if (id === scanId) setLoading(false);
  }
  runReview(data, id); // classifier result is already on screen; Gemini adds its judgement after
}

el.file.addEventListener('change', () => {
  const file = el.file.files[0];
  el.file.value = ''; // allow re-selecting the same photo
  handleFile(file);
});

el.newPhoto.addEventListener('click', () => el.file.click());

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('dragging'); });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('dragging'));
}
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

document.addEventListener('paste', (e) => {
  if (e.target === el.askInput) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) handleFile(file);
});

el.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(el.askInput.value);
});

// ---------- Read aloud, Hindi toggle, try-on-phone ----------

function speakResults() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; } // second click stops
  const text = lastItems.map((it) => `${it.name}. ${streamInfo(it.stream).bin}. ${recText(it.recyclable)}. ${(it.disposal || [])[0] || ''}`).join(' ');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').startsWith(u.lang.slice(0, lang === 'hi' ? 2 : 5)));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

function renderLang() {
  el.langToggle.querySelector('.lang-label').textContent = lang === 'hi' ? 'English' : 'हिन्दी';
  el.langToggle.setAttribute('aria-label', lang === 'hi' ? 'Show answers in English' : 'Show answers in Hindi');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  });
}

async function showPhone() {
  el.phoneDlg.showModal();
  el.phoneQr.replaceChildren();
  el.phoneUrl.textContent = 'Finding this laptop on the network...';
  let url = '';
  try {
    const h = await (await fetch('/api/health')).json();
    url = h.lan_url && !h.lan_url.includes('?') ? h.lan_url : '';
  } catch { /* handled below */ }
  el.phoneUrl.textContent = url || 'No network address found. Connect this laptop to Wi-Fi or a hotspot.';
  if (!url) return;
  try { // QR is optional: needs internet for the library; the URL text works without it
    if (!window.QRCode) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
    new QRCode(el.phoneQr, { text: url, width: 176, height: 176 });
  } catch { /* offline: URL text only */ }
}

el.speak.addEventListener('click', speakResults);
el.phoneBtn.addEventListener('click', showPhone);
el.langToggle.addEventListener('click', () => {
  lang = lang === 'hi' ? 'en' : 'hi';
  try { localStorage.setItem('ecosort-lang', lang); } catch { /* private mode */ }
  renderLang();
  if (lastB64) handleFile(null, lastB64); // re-read the same photo in the new language
});
renderLang();

el.mockBadge.hidden = !MOCK;
initLlmStatus();
renderSuggestions();
renderLearn();
