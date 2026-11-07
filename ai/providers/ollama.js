// Owner: Алдияр. Local provider via Ollama for the local-LLM variant.
// /api/chat with structured output (format = JSON schema), temperature 0.

function toPlainSchema(s) {
  // Ollama expects JSON Schema; convert OpenAPI-style `nullable` to type unions.
  if (Array.isArray(s)) return s.map(toPlainSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'nullable' || k === 'propertyOrdering') continue;
    out[k] = toPlainSchema(v);
  }
  if (s.nullable) {
    out.type = [s.type, 'null'];
    if (out.enum) out.enum = [...out.enum, null];
  }
  return out;
}

export async function generate({ system, user, schema, model = process.env.OLLAMA_MODEL || 'qwen2.5:14b' }) {
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
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
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    text: json.message?.content || '',
    model: `ollama/${model}`,
    input_tokens: json.prompt_eval_count || 0,
    output_tokens: json.eval_count || 0,
  };
}
