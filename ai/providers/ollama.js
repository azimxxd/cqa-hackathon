import { requestJson } from "./request.js";
// Owner: Алдияр. Local provider via Ollama for the local-LLM variant.
// /api/chat with structured output (format = JSON schema), temperature 0.

function toPlainSchema(s) {
  // Ollama expects JSON Schema; convert OpenAPI-style `nullable` to type unions.
  if (Array.isArray(s)) return s.map(toPlainSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "nullable" || k === "propertyOrdering") continue;
    out[k] = toPlainSchema(v);
  }
  if (s.nullable) {
    out.type = [s.type, "null"];
    if (out.enum) out.enum = [...out.enum, null];
  }
  return out;
}

export async function generate({
  system,
  user,
  schema,
  model = process.env.OLLAMA_MODEL || "qwen2.5:14b",
}) {
  const url = (process.env.OLLAMA_URL || "http://localhost:11434").replace(
    /\/$/,
    "",
  );
  const { json, calls } = await requestJson({
    provider: "ollama",
    url: `${url}/api/chat`,
    model: `ollama/${model}`,
    maxAttempts: 3,
    maxBackoffMs: Number(process.env.OLLAMA_MAX_BACKOFF_MS ?? 3000),
    baseBackoffMs: 500,
    usage: (json) => ({
      input_tokens: json.prompt_eval_count || 0,
      output_tokens: json.eval_count || 0,
    }),
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema ? toPlainSchema(schema) : "json",
        options: { temperature: 0, seed: 7, num_ctx: 16384 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
  });
  return {
    calls,
    text: json.message?.content || "",
    model: `ollama/${model}`,
    input_tokens: json.prompt_eval_count || 0,
    output_tokens: json.eval_count || 0,
  };
}
