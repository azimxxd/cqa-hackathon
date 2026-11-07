import { requestJson } from "./request.js";
import { ollamaUrl, ollamaHeaders } from "../router.js";
// Owner: Алдияр. Local provider via Ollama for the local-LLM variant.
// /api/chat with structured output (format = JSON schema), temperature 0.

export function toPlainSchema(s) {
  // Ollama expects JSON Schema; convert OpenAPI-style `nullable` to type unions.
  if (Array.isArray(s)) return s.map(toPlainSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "nullable" || k === "propertyOrdering") continue;
    out[k] = toPlainSchema(v);
  }
  if (s.nullable) {
    out.type = [...new Set([].concat(out.type, "null"))];
    if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  return out;
}

export async function generate({
  system,
  user,
  schema,
  model = process.env.OLLAMA_MODEL || "qwen2.5:14b",
  temperature = 0,
  seed = 7,
  config,
}) {
  const url = ollamaUrl();
  const { json, calls } = await requestJson({
    provider: "ollama",
    url: `${url}/api/chat`,
    model: `ollama/${model}`,
    maxAttempts: 3,
    maxBackoffMs: Number(process.env.OLLAMA_MAX_BACKOFF_MS ?? 3000),
    baseBackoffMs: 500,
    usage: (json) => ({
      input_tokens: json?.prompt_eval_count || 0,
      output_tokens: json?.eval_count || 0,
    }),
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...ollamaHeaders() },
      body: JSON.stringify({
        model,
        stream: false,
        // Hybrid thinking models (Qwen3.x) think by default; the schema already has a reasoning field.
        think: config ? config.ollamaThink : process.env.OLLAMA_THINK === "1",
        format: schema ? toPlainSchema(schema) : "json",
        options: { temperature, seed, num_ctx: config ? config.ollamaNumCtx : Number(process.env.OLLAMA_NUM_CTX || 16384) },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
  });
  return {
    calls,
    text: json?.message?.content || "",
    model: `ollama/${model}`,
    input_tokens: json?.prompt_eval_count || 0,
    output_tokens: json?.eval_count || 0,
  };
}
