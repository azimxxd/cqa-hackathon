// Owner: Алдияр. Contract in shared/schemas.md.
// Builds the prompt from the checklist version (never hardcode criteria), calls the provider,
// validates the answer (ids exist, scale value allowed, N/A only if na_allowed), retries once.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildPrompt, responseSchema, PROMPT_VERSION } from './prompt.js';
import { normalize, validateResult, sanitize } from './validate.js';
import { FEW_SHOT } from './fewshot.js';

export { PROMPT_VERSION };

async function getProvider() {
  const name = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (name === 'ollama') return import('./providers/ollama.js');
  return import('./providers/gemini.js');
}

export function modelName() {
  return (process.env.LLM_PROVIDER || 'gemini').toLowerCase() === 'ollama'
    ? `ollama/${process.env.OLLAMA_MODEL || 'qwen2.5:14b'}`
    : process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
}

export function costUsd(model, input, output) {
  if (String(model).startsWith('ollama/')) return 0;
  const pin = Number(process.env.PRICE_INPUT_PER_M ?? 0.3);
  const pout = Number(process.env.PRICE_OUTPUT_PER_M ?? 2.5);
  return +((input * pin + output * pout) / 1e6).toFixed(6);
}

export function criterionHash(c) {
  if (c.hash) return c.hash;
  return createHash('sha1').update(JSON.stringify([c.title, c.type, c.description, c.na_condition, c.scale, c.na_allowed, c.gross_error])).digest('hex');
}

/** Accepts both the stored Conversation shape and the raw organizer record ({transcript:[...]}) */
export function toConversation(conv) {
  const src = conv.messages || conv.transcript || [];
  return {
    ...conv,
    messages: src.map((m, i) => ({ ...m, id: m.id || 'm' + String(i + 1).padStart(3, '0'), idx: m.idx ?? i })),
  };
}

// Optional disk cache: AI_CACHE_DIR=... (key = conversation_id + criterion hash + prompt version + model).
const memCache = new Map();
function cacheKey(conv, c, model) {
  return createHash('sha1').update([conv.conversation_id, criterionHash(c), PROMPT_VERSION, model].join('|')).digest('hex');
}
function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) {
    const f = path.join(dir, key + '.json');
    if (existsSync(f)) { const v = JSON.parse(readFileSync(f, 'utf8')); memCache.set(key, v); return v; }
  }
  return null;
}
function cacheSet(key, v) {
  memCache.set(key, v);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, key + '.json'), JSON.stringify(v)); }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * @param {object} conversation Conversation (shared/schemas.md) or raw organizer record
 * @param {object[]} criteria Criterion[] — all or only changed ones
 * @param {object} checklistMeta {first_reaction_threshold_sec, ...}
 * @param {{noCache?: boolean}} [opts]
 * @returns {Promise<{results: object[], calls: object[]}>}
 */
export async function evaluateConversation(conversation, criteria, checklistMeta = {}, opts = {}) {
  const conv = toConversation(conversation);
  const model = modelName();
  const results = new Map();
  const calls = [];

  const todo = [];
  for (const c of criteria) {
    const hit = opts.noCache ? null : cacheGet(cacheKey(conv, c, model));
    if (hit) results.set(c.id, hit); else todo.push(c);
  }

  if (todo.length) {
    const provider = await getProvider();
    let pending = todo;
    let feedback = null;
    const raws = new Map();

    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const { system, user } = buildPrompt(conv, pending, checklistMeta, { fewShot: FEW_SHOT, feedback });
      const schema = responseSchema(pending);
      const t = Date.now();
      let resp;
      try {
        resp = await provider.generate({ system, user, schema });
      } catch (e) {
        // provider already retried 429/5xx; give up only if nothing usable was produced
        if (e.fatal || attempt === 1) { if (raws.size) break; throw e; }
        continue;
      }
      calls.push({
        model: resp.model,
        input_tokens: resp.input_tokens,
        output_tokens: resp.output_tokens,
        cost_usd: costUsd(resp.model, resp.input_tokens, resp.output_tokens),
        latency_ms: Date.now() - t,
        prompt: `${system}\n\n${user}`,
        raw_response: resp.text,
      });
      const parsed = parseJson(resp.text);
      const items = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : [];
      const errors = [];
      for (const c of pending) {
        const raw = items.find((x) => x && x.criterion_id === c.id);
        if (!raw) { errors.push(`${c.id}: нет результата`); continue; }
        const r = normalize(raw, c, conv);
        raws.set(c.id, r);
        const errs = validateResult(r, c, conv);
        if (errs.length) errors.push(...errs); else results.set(c.id, r);
      }
      pending = pending.filter((c) => !results.has(c.id));
      feedback = parsed ? errors.join('; ') || null : 'ответ не является корректным JSON';
    }

    for (const c of todo) {
      if (!results.has(c.id)) {
        const r = raws.get(c.id) || { criterion_id: c.id, answer: null, scale_value: null, explanation: '', evidence_ids: [], checked_range: null };
        results.set(c.id, sanitize(r, c, conv));
      } else {
        const clean = sanitize(results.get(c.id), c, conv);
        results.set(c.id, clean);
        cacheSet(cacheKey(conv, c, model), clean);
      }
    }
  }

  return { results: criteria.map((c) => results.get(c.id)), calls };
}
