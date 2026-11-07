// Owner: Алдияр. Contract in shared/schemas.md.
// Builds the prompt from the checklist version (never hardcode criteria), calls the provider,
// validates the answer (ids exist, scale value allowed, N/A only if na_allowed), retries once.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildPrompt, responseSchema, PROMPT_VERSION } from './prompt.js';
import { normalize, validateResult, sanitize } from './validate.js';
import { FEW_SHOT } from './fewshot.js';
import { offsetOf, resolveT0 } from './timing.js';

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
  const rawIn = process.env.PRICE_INPUT_PER_M;
  const rawOut = process.env.PRICE_OUTPUT_PER_M;
  const pin = rawIn !== undefined && String(rawIn).trim() !== '' ? Number(rawIn) : 0.3;
  const pout = rawOut !== undefined && String(rawOut).trim() !== '' ? Number(rawOut) : 2.5;
  return +(((Number(input) || 0) * pin + (Number(output) || 0) * pout) / 1e6).toFixed(6);
}

export function criterionHash(c) {
  return createHash('sha1')
    .update(JSON.stringify([c.id, c.title, c.type, c.description, c.na_condition, c.scale, c.na_allowed, c.gross_error, c.hash || null]))
    .digest('hex');
}

/** Accepts both the stored Conversation shape ({messages:[...]}) and raw organizer record ({transcript:[...]}) */
export function toConversation(conv) {
  const src = Array.isArray(conv?.messages) ? conv.messages : Array.isArray(conv?.transcript) ? conv.transcript : [];
  const t0 = resolveT0(src);
  return {
    ...conv,
    conversation_id: conv?.conversation_id ?? 'unknown',
    channel: conv?.channel ?? 'agent chat',
    language: conv?.language ?? 'RU',
    audio_url: conv?.audio_url ?? null,
    messages: src.map((m, i) => ({
      ...m,
      id: m.id || 'm' + String(i + 1).padStart(3, '0'),
      idx: m.idx ?? i,
      offset_sec: typeof m.offset_sec === 'number' && Number.isFinite(m.offset_sec) ? m.offset_sec : offsetOf(m, t0),
      speaker: m.speaker || 'client',
      text: String(m.text ?? ''),
    })),
  };
}

// Optional disk cache: AI_CACHE_DIR=... (key = conversation + transcript hash + criterion hash + threshold + prompt version + model).
const memCache = new Map();
function cacheKey(conv, c, model, checklistMeta) {
  const msgSig = createHash('sha1')
    .update(JSON.stringify((conv.messages || []).map((m) => [m.id, m.timestamp, m.offset_sec, m.speaker, m.text])))
    .digest('hex');
  const threshold = checklistMeta?.first_reaction_threshold_sec ?? 180;
  return createHash('sha1')
    .update([conv.conversation_id, msgSig, criterionHash(c), threshold, PROMPT_VERSION, model].join('|'))
    .digest('hex');
}
function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) {
    const f = path.join(dir, key + '.json');
    if (existsSync(f)) {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        memCache.set(key, v);
        return v;
      } catch {}
    }
  }
  return null;
}
function cacheSet(key, v) {
  memCache.set(key, v);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, key + '.json'), JSON.stringify(v));
  }
}

export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * @param {object} conversation Conversation (shared/schemas.md) or raw organizer record
 * @param {object[]} criteria Criterion[] — all or only changed ones
 * @param {object} [checklistMeta] {first_reaction_threshold_sec, rounding, ...}
 * @param {{noCache?: boolean, provider?: {generate: Function}}} [opts]
 * @returns {Promise<{results: object[], calls: object[]}>}
 */
export async function evaluateConversation(conversation, criteria, checklistMeta = {}, opts = {}) {
  const conv = toConversation(conversation);
  const model = modelName();
  const results = new Map();
  const calls = [];

  if (!Array.isArray(criteria) || !criteria.length) {
    return { results: [], calls: [] };
  }

  const todo = [];
  for (const c of criteria) {
    const hit = opts.noCache ? null : cacheGet(cacheKey(conv, c, model, checklistMeta));
    if (hit) results.set(c.id, sanitize(hit, c, conv));
    else todo.push(c);
  }

  if (todo.length) {
    const provider = opts.provider || await getProvider();
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
        if (e.fatal || attempt === 1) { if (raws.size) break; throw e; }
        continue;
      }
      calls.push({
        model: resp.model,
        input_tokens: resp.input_tokens || 0,
        output_tokens: resp.output_tokens || 0,
        cost_usd: costUsd(resp.model, resp.input_tokens, resp.output_tokens),
        latency_ms: Date.now() - t,
        prompt: `${system}\n\n${user}`,
        raw_response: String(resp.text ?? ''),
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
        if (errs.length) errors.push(...errs);
        else results.set(c.id, r);
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
        cacheSet(cacheKey(conv, c, model, checklistMeta), clean);
      }
    }
  }

  return { results: criteria.map((c) => results.get(c.id)), calls };
}
