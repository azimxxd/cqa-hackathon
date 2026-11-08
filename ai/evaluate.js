import { evaluationConfig, configHash, sampleCount } from "./config.js";
export { sampleCount } from "./config.js";
// Owner: Алдияр. Contract in shared/schemas.md.
// Builds the prompt from the checklist version (never hardcode criteria), calls the provider,
// validates the answer (ids exist, scale value allowed, N/A only if na_allowed), retries once.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { buildPrompt, responseSchema, PROMPT_VERSION } from "./prompt.js";
import { normalize, validateResult, quoteFlags } from "./validate.js";
import { FEW_SHOT, isDefaultCriterion } from "./fewshot.js";
import { parseTimestampSec, offsetOf } from "./timing.js";
import { activeProvider, ollamaModel } from "./router.js";

export { PROMPT_VERSION };

async function getProvider(model) {
  const name = model.startsWith("ollama/") ? "ollama" : "gemini";
  if (name === "ollama") return import("./providers/ollama.js");
  return import("./providers/gemini.js");
}

export function modelName() {
  return activeProvider() === "ollama"
    ? `ollama/${ollamaModel()}`
    : process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
}

export function costUsd(model, input, output) {
  if (String(model).startsWith("ollama/")) return 0;
  const pin = Number(process.env.PRICE_INPUT_PER_M?.trim() || 0.25);
  const pout = Number(process.env.PRICE_OUTPUT_PER_M?.trim() || 1.5);
  return +(
    ((Number(input) || 0) * pin + (Number(output) || 0) * pout) /
    1e6
  ).toFixed(6);
}

export function criterionHash(c) {
  if (c.hash) return c.hash;
  return createHash("sha1")
    .update(
      JSON.stringify([
        c.title,
        c.type,
        c.description,
        c.na_condition ?? null,
        c.scale ?? null,
      ]),
    )
    .digest("hex");
}

/** Accepts both the stored Conversation shape and the raw organizer record ({transcript:[...]}) */
export function toConversation(conv) {
  const src = Array.isArray(conv?.messages)
    ? conv.messages
    : Array.isArray(conv?.transcript)
      ? conv.transcript
      : [];
  const first = parseTimestampSec(src[0]?.timestamp);
  return {
    ...conv,
    messages: src.map((m, i) => ({
      ...m,
      id: m.id || "m" + String(i + 1).padStart(3, "0"),
      idx: m.idx ?? i,
      offset_sec: offsetOf(m, first),
    })),
  };
}

// Optional disk cache: AI_CACHE_DIR=... (key = conversation_id + criterion hash + prompt version + model).
const memCache = new Map();
function cacheKey(conv, c, model, meta, config) {
  return createHash("sha1")
    .update(
      [
        conv.conversation_id,
        createHash("sha1")
          .update(
            JSON.stringify([
              conv.channel,
              conv.language,
              conv.messages.map((m) => [
                m.id,
                m.timestamp,
                m.offset_sec,
                m.speaker,
                m.text,
              ]),
            ]),
          )
          .digest("hex"),
        criterionHash(c),
        PROMPT_VERSION,
        model,
        c.id === "c06" ? (meta.first_reaction_threshold_sec ?? 180) : null,
        configHash(config),
      ].join("|"),
    )
    .digest("hex");
}
function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) {
    const f = path.join(dir, key + ".json");
    try {
      const v = JSON.parse(readFileSync(f, "utf8"));
      memCache.set(key, v);
      return v;
    } catch (error) {
      // Interrupted writes and concurrent cache removal are cache misses.
      if (!(error instanceof SyntaxError) && error.code !== "ENOENT")
        throw error;
    }
  }
  return null;
}
function cacheSet(key, v) {
  memCache.set(key, v);
  const dir = process.env.AI_CACHE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, key + ".json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(v), { flag: "wx" });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

/** Self-consistency: majority answer for binary/N/A, median for scales; keeps a real sample's explanation. */
export function aggregate(criterion, samples) {
  const valid = samples.filter(Boolean);
  const key = (r) => (r.answer === "na" ? "na" : criterion.type === "scale" ? r.scale_value : r.answer);
  const counts = new Map();
  for (const r of valid) counts.set(key(r), (counts.get(key(r)) || 0) + 1);
  let winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const top = [...counts.values()].sort((a, b) => b - a);
  if (criterion.type === "scale" && top.length > 1 && top[0] === top[1]) {
    // Tie on a scale: take the median of numeric samples (lower median, stays on the scale).
    const nums = valid.filter((r) => r.answer !== "na").map((r) => r.scale_value).sort((a, b) => a - b);
    if (nums.length) winner = nums[Math.floor((nums.length - 1) / 2)];
  } else if (top.length > 1 && top[0] === top[1]) winner = key(valid[0]); // binary tie: deterministic first sample
  const chosen = valid.find((r) => key(r) === winner);
  return {
    ...chosen,
    consistency: { samples: valid.length, agree: valid.filter((r) => key(r) === winner).length },
  };
}

async function runModel(conv, criteria, checklistMeta, provider, model, appendCalls, sampling, focused = false) {
  const results = new Map();
  let pending = criteria,
    feedback = null,
    details = [];
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const { system, user } = buildPrompt(conv, pending, checklistMeta, {
      fewShot: FEW_SHOT,
      focused,
      feedback,
    });
    let resp;
    try {
      resp = await provider.generate({
        system,
        user,
        schema: responseSchema(pending),
        model: model.replace(/^ollama\//, ""),
        ...sampling,
      });
    } catch (error) {
      appendCalls(error.calls, system, user);
      throw error; // Provider owns transient retries; second pass is for validation only.
    }
    appendCalls(resp.calls || [resp], system, user);
    const parsed = parseJson(resp.text);
    const items = Array.isArray(parsed?.results)
      ? parsed.results
      : Array.isArray(parsed)
        ? parsed
        : [];
    details = [];
    for (const c of pending) {
      const matches = items.filter((x) => x && x.criterion_id === c.id);
      if (matches.length !== 1) {
        details.push(`${c.id}: нет результата или дубликат`);
        continue;
      }
      const r = normalize(matches[0], c, conv);
      const errors = validateResult(r, c, conv);
      if (errors.length) details.push(...errors);
      else results.set(c.id, r);
    }
    pending = pending.filter((c) => !results.has(c.id));
    feedback = details.join("; ") || "ответ не является корректным JSON";
  }
  if (pending.length)
    throw Object.assign(Error(`Invalid AI results: ${details.join("; ")}`), {
      invalidResult: true,
      criteria: pending.map((c) => c.id),
      details,
      partial: [...results.values()],
    });
  return results;
}

const CLARIFICATION_CHECK = {
  id: "clarification_check",
  title: "Переспрашивание из-за ответа оператора",
  type: "binary",
  na_allowed: false,
  description: "Да — клиент после непонятного, расплывчатого или не по порядку данного ответа оператора был вынужден повторить прежний вопрос или попросить уточнить сам ответ. Позднейшее исправление ответа не меняет факт переспрашивания. Для «да» укажи ровно две реплики: предыдущий неясный ответ оператора и последовавшее переспрашивание клиента. Нет — клиент задал новый вопрос, ответил на уточнение оператора или не просил прояснить его ответ.",
};

async function recheckCriterion(conv, criterion, checklistMeta, provider, model, appendCalls, sampling) {
  const rows = await runModel(conv, [criterion], checklistMeta, provider, model, appendCalls, sampling, true);
  const result = rows.get(criterion.id);
  if (criterion.id !== "c06" || ![7, 10].includes(result.scale_value)) return result;

  // The official 4/10 step follows from a specific observed pair of turns.
  // Let the model identify the pair, then apply the rubric independently of the final outcome.
  const checked = await runModel(conv, [CLARIFICATION_CHECK], checklistMeta, provider, model, appendCalls, sampling);
  const fact = checked.get(CLARIFICATION_CHECK.id);
  if (fact.answer !== "yes" || fact.evidence_ids.length !== 2) return result;
  const pair = conv.messages.filter(message => fact.evidence_ids.includes(message.id));
  if (pair[0]?.speaker !== "operator" || pair[1]?.speaker !== "client") return result;
  return {
    ...result,
    scale_value: 4,
    explanation: fact.explanation,
    evidence_ids: pair.map(message => message.id),
    checked_range: { from: pair[0].id, to: pair[1].id },
  };
}

// Keep the existing rubric pass. Qwen then rechecks official clarity and closing
// individually so a solved problem cannot erase a clarification or decide closure.
async function runSample(conv, criteria, checklistMeta, provider, model, appendCalls, sampling) {
  const rechecks = model.startsWith("ollama/qwen")
    ? criteria.filter(c => ["c06", "c07"].includes(c.id) && isDefaultCriterion(c))
    : [];
  if (criteria.length === 1 && rechecks.length)
    return new Map([[criteria[0].id, await recheckCriterion(conv, criteria[0], checklistMeta, provider, model, appendCalls, sampling)]]);

  const initial = rechecks.length === criteria.length
    ? new Map()
    : await runModel(conv, criteria, checklistMeta, provider, model, appendCalls, sampling);
  for (const criterion of rechecks) {
    const result = await recheckCriterion(conv, criterion, checklistMeta, provider, model, appendCalls, sampling);
    initial.set(criterion.id, result);
  }
  return initial;
}

/**
 * @param {object} conversation Conversation (shared/schemas.md) or raw organizer record
 * @param {object[]} criteria Criterion[] — all or only changed ones
 * @param {object} checklistMeta {first_reaction_threshold_sec, ...}
 * @param {{noCache?: boolean, samples?: number, provider?: {generate: Function}}} [opts]
 * @returns {Promise<{results: object[], calls: object[]}>}
 */
export async function evaluateConversation(
  conversation,
  criteria,
  checklistMeta = {},
  opts = {},
) {
  const config = evaluationConfig(opts.config ?? { samples: opts.samples });
  const conv = toConversation(conversation);
  const model = checklistMeta.model ?? modelName();
  const results = new Map();
  const calls = [];

  const todo = [];
  for (const c of criteria) {
    const hit = opts.noCache
      ? null
      : cacheGet(cacheKey(conv, c, model, checklistMeta, config));
    if (
      hit &&
      validateResult({ ...hit, criterion_id: c.id }, c, conv).length === 0
    )
      results.set(c.id, { ...hit, criterion_id: c.id });
    else todo.push(c);
  }

  const appendCalls = (records, system, user) => {
    for (const call of records || [])
      calls.push({
        ...call,
        cost_usd: costUsd(
          call.model || model,
          call.input_tokens || 0,
          call.output_tokens || 0,
        ),
        prompt: `${system}\n\n${user}`,
      });
  };
  try {
    if (todo.length) {
      const provider = opts.provider ?? (await getProvider(model));
      const samples = config.samples;
      const runs = [];
      for (let i = 0; i < samples; i++)
        runs.push(
          runSample(conv, todo, checklistMeta, provider, model, appendCalls, { config, temperature: i === 0 ? 0 : config.sampleTemperature, seed: 7 + i }),
        );
      const settled = await Promise.allSettled(runs);
      const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
      if (!ok.length) throw settled[0].reason;
      for (const c of todo) {
        const r = samples > 1 ? aggregate(c, ok.map((run) => run.get(c.id))) : ok[0].get(c.id);
        if (samples > 1) r.consistency.requested = samples;
        const flags = quoteFlags(r, conv);
        results.set(c.id, flags.length ? { ...r, review_flags: flags } : r);
      }
      if (!opts.noCache)
        for (const c of todo)
          cacheSet(cacheKey(conv, c, model, checklistMeta, config), results.get(c.id));
    }
    return {
      results: criteria.map((c) => results.get(c.id)),
      calls,
      cached_count: criteria.length - todo.length,
      evaluated_criteria: todo.map((c) => c.id),
    };
  } catch (error) {
    error.calls = calls;
    error.cached_count = criteria.length - todo.length;
    error.evaluated_criteria = todo.map((c) => c.id);
    throw error;
  }
}
