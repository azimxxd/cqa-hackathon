// Owner: Алдияр. Gemini provider: temperature 0, JSON response, returns text + token usage.
// REST generateContent; retries with exponential backoff on 429/5xx/network errors.

let keyIndex = 0;
export function getKeys() {
  const raw =
    [
      process.env.GEMINI_API_KEYS,
      process.env.GEMINI_API_Keys,
      process.env.GEMINI_API_KEY,
    ].find((value) => typeof value === "string" && value.trim()) || "";
  const keys = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
  if (!keys.length)
    throw Object.assign(Error("GEMINI_API_KEY is not set (see .env.example)"), {
      fatal: true,
      provider: "gemini",
    });
  return keys;
}
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
import { requestJson } from "./request.js";

export async function generate({
  system,
  user,
  schema,
  model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
}) {
  const keys = getKeys();
  const maxAttempts = Number(process.env.GEMINI_MAX_ATTEMPTS ?? 4);
  const generationConfig = {
    temperature: 0,
    topP: 1,
    seed: 7,
    responseMimeType: "application/json",
    ...(schema ? { responseSchema: schema } : {}),
  };
  const budget = process.env.GEMINI_THINKING_BUDGET;
  if (budget !== undefined && budget !== "" && /2\.5/.test(model))
    generationConfig.thinkingConfig = { thinkingBudget: Number(budget) };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };

  const { json, calls } = await requestJson({
    provider: "gemini",
    url: `${BASE}/${model}:generateContent`,
    model,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    headersForAttempt: () => ({
      "content-type": "application/json",
      "x-goog-api-key": keys[keyIndex++ % keys.length],
    }),
    rotateKey: (status, attempt) =>
      [400, 403].includes(status) &&
      attempt + 1 < Math.min(keys.length, maxAttempts),
    maxAttempts,
    maxBackoffMs: Number(process.env.GEMINI_MAX_BACKOFF_MS ?? 30000),
    baseBackoffMs: 2000,
    usage: (json) => ({
      input_tokens: json?.usageMetadata?.promptTokenCount || 0,
      output_tokens:
        (json?.usageMetadata?.candidatesTokenCount || 0) +
        (json?.usageMetadata?.thoughtsTokenCount || 0),
    }),
  });
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = (Array.isArray(parts) ? parts : [])
    .filter((p) => p && !p.thought)
    .map((p) => p.text || "")
    .join("");
  // Empty model output is handled by evaluate's validation retry and keeps its usage log.
  return {
    text,
    model,
    input_tokens: calls.at(-1).input_tokens,
    output_tokens: calls.at(-1).output_tokens,
    calls,
  };
}
