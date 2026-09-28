// Gemini layer (owner: A): judges the classifier JSON and answers questions in natural language.
// Key comes from config.js (gitignored). The browser calls the Gemini API directly.
'use strict';

const Gemini = (() => {
  const CFG = window.ECOSORT_CONFIG || {};
  const API_KEY = CFG.GEMINI_API_KEY || '';
  const MODELS = CFG.GEMINI_MODELS || ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
  const TIMEOUT_MS = 30_000;
  const STREAM_ENUM = ['wet', 'dry', 'hazardous', 'e-waste', 'unknown'];

  const SYSTEM = [
    'You are EcoSort, an expert on household waste segregation in India.',
    'Bins: GREEN = wet (food, plants), BLUE = dry (plastic, paper, glass, metal, textile).',
    'Hazardous (batteries, medicines, chemicals, paint, bulbs) and e-waste (electronics, chargers, cables) are kept separate and never mixed.',
    'A small on-device vision model produced the classification you are given; it can be wrong.',
    'Be concise, practical and friendly. Plain text only, no markdown, no em-dashes.',
  ].join(' ');

  const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-3 sentence plain-language overview of what to do with everything in the photo.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Index of the item in the input list.' },
            verdict: { type: 'string', enum: ['correct', 'check', 'wrong'] },
            suggested_stream: { type: 'string', enum: STREAM_ENUM },
            note: { type: 'string', description: 'One short sentence: why, or what to double-check.' },
          },
          required: ['index', 'verdict', 'suggested_stream', 'note'],
        },
      },
    },
    required: ['summary', 'items'],
  };

  let history = []; // chat turns: {role:'user'|'model', parts:[{text}]}

  function enabled() { return Boolean(API_KEY); }

  async function call(body) {
    let lastErr;
    for (const model of MODELS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const t0 = performance.now();
      try {
        const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = new Error(data.error?.message || `Gemini error ${res.status}`);
          if (res.status === 429 || res.status === 404 || res.status >= 500) continue; // try next model
          throw lastErr;
        }
        const parts = data.candidates?.[0]?.content?.parts || [];
        const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
        if (!text) throw new Error('Gemini returned no text');
        return { text, model, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        lastErr = err.name === 'AbortError' ? new Error('Gemini timed out. Check the internet connection.') : err;
        if (err.name !== 'AbortError' && !(err instanceof TypeError)) throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof TypeError) throw new Error('Cannot reach Gemini. Are you online?');
    throw lastErr;
  }

  /** Judges the classifier output. Returns {summary, items:[{index, verdict, suggested_stream, note}], model, ms}. */
  async function review(classification) {
    const payload = (classification.items || []).map((it, index) => ({
      index, name: it.name, material: it.material, stream: it.stream, recyclable: it.recyclable,
    }));
    const prompt =
      'Review this waste classification from the vision model. For every item, judge whether the stream ' +
      '(and therefore the bin) is correct for India, give the stream you would use, and a one-line note. ' +
      'Then write a short summary telling the user exactly what to do.\n\n' +
      JSON.stringify(payload);
    const out = await call({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA },
    });
    const parsed = JSON.parse(out.text);
    history = []; // new scan → fresh conversation
    return { ...parsed, model: out.model, ms: out.ms };
  }

  /** Free-form Q&A grounded in the last scan + review. Returns {answer, model, ms}. */
  async function ask(question, context) {
    const ctx = context && context.items?.length
      ? `Context — last scan and your review:\n${JSON.stringify(context)}`
      : 'Context — nothing scanned yet.';
    history.push({ role: 'user', parts: [{ text: question }] });
    try {
      const out = await call({
        systemInstruction: { parts: [{ text: `${SYSTEM} Answer in 2-4 short sentences.\n${ctx}` }] },
        contents: history.slice(-10),
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      });
      history.push({ role: 'model', parts: [{ text: out.text }] });
      return { answer: out.text.trim(), model: out.model, ms: out.ms };
    } catch (err) {
      history.pop();
      throw err;
    }
  }

  return { enabled, review, ask };
})();
