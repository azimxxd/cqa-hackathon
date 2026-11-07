// Owner: Алдияр. Gemini provider: temperature 0, JSON response, returns text + token usage.
// Supports multiple comma/semicolon-separated keys in GEMINI_API_KEY / GEMINI_API_KEYS (round-robin + rotation on 429/403).

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let keyIdx = 0;

export function getKeys() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_Keys || process.env.GEMINI_API_KEY || '';
  const list = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('GEMINI_API_KEY is not set (see .env.example)'), { fatal: true });
  return list;
}

export async function generate({ system, user, schema, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite' }) {
  const keys = getKeys();
  const generationConfig = {
    temperature: 0,
    topP: 1,
    seed: 7,
    responseMimeType: 'application/json',
    ...(schema ? { responseSchema: schema } : {}),
  };
  const budget = process.env.GEMINI_THINKING_BUDGET;
  if (budget !== undefined && budget !== '') generationConfig.thinkingConfig = { thinkingBudget: Number(budget) };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  };

  let curModel = model;
  let lastErr;
  const maxAttempts = Math.max(6, keys.length * 3);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = keys[keyIdx++ % keys.length];
    try {
      const res = await fetch(`${BASE}/${curModel}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 404 && /^gemini-2\.5/.test(curModel)) {
        curModel = 'gemini-3.5-flash-lite';
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        if (attempt + 1 < keys.length) continue;
        const ra = Number(res.headers.get('retry-after'));
        const round = Math.floor(attempt / keys.length);
        await sleep(ra > 0 ? ra * 1000 : Math.min(30_000, 1500 * 2 ** round) + Math.random() * 500);
        continue;
      }
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
        // If one key in the pool is invalid/revoked (400/403), rotate to the remaining keys before giving up
        if ((res.status === 400 || res.status === 403) && keys.length > 1 && attempt + 1 < keys.length) {
          lastErr = err;
          continue;
        }
        throw Object.assign(err, { fatal: true });
      }
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      const u = json.usageMetadata || {};
      if (!text) {
        lastErr = new Error(`Gemini empty response (finishReason=${cand?.finishReason})`);
        await sleep(800);
        continue;
      }
      return {
        text,
        model: curModel,
        input_tokens: u.promptTokenCount || 0,
        output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr;
}
