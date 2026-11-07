// LLM_PROVIDER=auto: use local Ollama (Qwen on the GPU box) while it answers, Gemini otherwise.
// The decision is cached and refreshed in the background so job submission stays synchronous.
// The GPU box registers its current public URL via POST /api/ai/ollama-endpoint (see deploy/brev).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const state = { online: false, checkedAt: null, error: null, url: null, registeredAt: null };
let timer = null;

export const autoMode = () => (process.env.LLM_PROVIDER || "").toLowerCase() === "auto";
export const ollamaModel = () => process.env.OLLAMA_MODEL || "qwen2.5:14b";
export const ollamaUrl = () => (state.url || process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
export const ollamaHeaders = () =>
  process.env.OLLAMA_API_KEY ? { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {};
export const routerState = () => ({ ...state, url: state.url ? new URL(state.url).host : null });

/** Provider for the next job: "ollama" or "gemini". */
export function activeProvider() {
  if (autoMode()) return state.online ? "ollama" : "gemini";
  return (process.env.LLM_PROVIDER || "gemini").toLowerCase() === "ollama" ? "ollama" : "gemini";
}

const endpointFile = () => process.env.OLLAMA_ENDPOINT_FILE || "";

export function loadRegisteredEndpoint() {
  const file = endpointFile();
  if (!file) return;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved?.url === "string") Object.assign(state, { url: saved.url, registeredAt: saved.at ?? null });
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

/** Accepts only a plain https origin (the tunnel URL), persists it and re-probes at once. */
export async function registerEndpoint(url, { fetchImpl = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(Error("url must be an https origin"), { status: 400 });
  }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.username)
    throw Object.assign(Error("url must be an https origin"), { status: 400 });
  state.url = parsed.origin;
  state.registeredAt = new Date().toISOString();
  const file = endpointFile();
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ url: state.url, at: state.registeredAt }), { flag: "wx" });
    renameSync(temp, file);
  }
  await probe({ fetchImpl });
  return routerState();
}

/** Online = the endpoint answers and has the configured model loaded or pulled. */
export async function probe({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${ollamaUrl()}/api/tags`, {
      headers: ollamaHeaders(),
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_PROBE_TIMEOUT_MS || 5000)),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = await response.json();
    const names = (body?.models || []).map((m) => m.name || m.model);
    if (!names.includes(ollamaModel())) throw Error(`model ${ollamaModel()} not found`);
    Object.assign(state, { online: true, error: null });
  } catch (error) {
    Object.assign(state, { online: false, error: error.message });
  }
  state.checkedAt = new Date().toISOString();
  return state.online;
}

export function startAutoRouting() {
  if (!autoMode() || timer) return;
  loadRegisteredEndpoint();
  probe();
  timer = setInterval(probe, Number(process.env.OLLAMA_PROBE_INTERVAL_MS || 20000));
  timer.unref?.();
}

export function stopAutoRouting() {
  clearInterval(timer);
  timer = null;
}

/** Test helper. */
export function resetRouter() {
  stopAutoRouting();
  Object.assign(state, { online: false, checkedAt: null, error: null, url: null, registeredAt: null });
}
