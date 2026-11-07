// Owner: Алдияр. Local provider via Ollama for the local-LLM variant.
// /api/chat with structured output (format = JSON schema), temperature 0, with retry on transient errors.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toPlainSchema(s) {
  // Ollama expects JSON Schema; convert OpenAPI-style `nullable` to type unions.
  if (Array.isArray(s)) return s.map(toPlainSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'nullable' || k === 'propertyOrdering') continue;
    out[k] = toPlainSchema(v);
  }
  if (s.nullable) {
    out.type = Array.isArray(out.type) ? [...new Set([...out.type, 'null'])] : [out.type, 'null'];
    if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  return out;
}

export async function generate({ system, user, schema, model = process.env.OLLAMA_MODEL || 'qwen2.5:14b' }) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: schema ? toPlainSchema(schema) : 'json',
          options: { temperature: 0, seed: 7, num_ctx: 16384 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
      const json = await res.json();
      const text = json.message?.content || '';
      if (!text) {
        lastErr = new Error('Ollama empty response');
        await sleep(500);
        continue;
      }
      return {
        text,
        model: `ollama/${model}`,
        input_tokens: json.prompt_eval_count || 0,
        output_tokens: json.eval_count || 0,
      };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}
