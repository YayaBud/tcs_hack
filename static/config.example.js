// Copy to config.js (gitignored) and paste your key from https://aistudio.google.com/apikey
window.ECOSORT_CONFIG = {
  GEMINI_API_KEY: '',
  // Tried in order; falls through on 429 / 404 / 5xx.
  GEMINI_MODELS: ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
};
