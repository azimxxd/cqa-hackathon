// Owner: Алдияр. Gemini provider: temperature 0, JSON response, returns text + token usage.
// REST generateContent; retries with exponential backoff on 429/5xx/network errors.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generate({ system, user, schema, model = process.env.GEMINI_MODEL || 'gemini-2.5-flash' }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set (see .env.example)');
  const generationConfig = {
    temperature: 0,
    topP: 1,
    seed: 7,
    responseMimeType: 'application/json',
    ...(schema ? { responseSchema: schema } : {}),
  };
  const budget = process.env.GEMINI_THINKING_BUDGET;
  if (budget !== undefined && budget !== '' && /2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: Number(budget) };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  };

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const ra = Number(res.headers.get('retry-after'));
        await sleep(ra > 0 ? ra * 1000 : Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000);
        continue;
      }
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`), { fatal: true });
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      const u = json.usageMetadata || {};
      if (!text) {
        lastErr = new Error(`Gemini empty response (finishReason=${cand?.finishReason})`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return {
        text,
        model,
        input_tokens: u.promptTokenCount || 0,
        // thinking tokens are billed as output
        output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    }
  }
  throw lastErr;
}
