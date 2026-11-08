import { evaluationConfig, configHash } from "../ai/config.js";
import { createHash, randomUUID } from "node:crypto";
import {
  evaluateConversation,
  PROMPT_VERSION,
  modelName,
} from "../ai/evaluate.js";
import { alignTranscription } from "../ai/transcription.js";
import { autoMode } from "../ai/router.js";
import { getChecklist, now, transaction } from "./db.js";
import { getConversation } from "./import.js";
import { createEvaluation, getEvaluation } from "./evaluations.js";
import { validateResult } from "./scoring.js";
import { fail, positiveId } from "./http.js";

// Explicit opt-in only. Fake results are labelled and isolated from the real model cache.
export async function fakeEvaluate(conversation, criteria) {
  const results = criteria.map((c) => ({
    criterion_id: c.id,
    answer: c.type === "scale" ? null : "yes",
    scale_value:
      c.type === "scale" ? Math.max(...c.scale.map((s) => s.value)) : null,
    explanation:
      "FAKE: deterministic server test result; not an AI assessment.",
    evidence_ids: conversation.messages.length ? [conversation.messages[0].id] : [],
    checked_range: null,
  }));
  return {
    results,
    calls: [
      {
        model: "fake",
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        latency_ms: 0,
        prompt: "FAKE",
        raw_response: JSON.stringify(results),
      },
    ],
  };
}
const transcriptHash = (messages) =>
  createHash("sha256").update(JSON.stringify(messages)).digest("hex");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createJobService(db, options = {}) {
  const config = evaluationConfig(options.config);
  const configId = configHash(config);
  const fake = options.fake ?? process.env.CQA_FAKE_LLM === "1";
  // Pinned unless LLM_PROVIDER=auto, where each job takes the provider that is online at submit time.
  const pinned = options.model ?? (fake ? "fake" : autoMode() ? null : modelName());
  const currentModel = () => pinned ?? modelName();
  const promptVersion =
    options.promptVersion ?? (fake ? "fake" : PROMPT_VERSION);
  const promptKey = (checklist, revision = promptVersion) =>
    `${revision}|frt=${checklist.first_reaction_threshold_sec ?? 180}`;
  // Timing threshold affects c06 only; unrelated criteria remain reusable.
  const cacheKey = (checklist, criterion, item, revision = promptVersion) => {
    const base = criterion.id === "c06"
      ? promptKey(checklist, revision)
      : `${revision}|frt=independent`;
    const configured = `${base}|config=${configId}`;
    return item.transcript_source === "gemini"
      ? `${configured}|transcript_source=gemini|transcript_hash=${item.transcript_hash}`
      : `${configured}|transcript_hash=${item.transcript_hash}`;
  };
  const evaluate =
    options.evaluate ?? (fake ? fakeEvaluate : evaluateConversation);
  const concurrency = Number(
    options.concurrency ?? process.env.LLM_CONCURRENCY ?? 6,
  );
  const retries = Number(options.retries ?? process.env.LLM_RETRIES ?? 1);
  const backoff = Number(
    options.backoffMs ?? process.env.LLM_BACKOFF_MS ?? 1000,
  );
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(retries) ||
    retries < 0 ||
    !Number.isFinite(backoff) ||
    backoff < 0
  )
    throw Error("Invalid LLM queue configuration");
  const jobs = new Map(),
    queue = [];
  let active = 0,
    closing = false;
  const persist = (job) =>
    db
      .prepare(
        "INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
  const logCalls = (id, calls = [], model = currentModel()) => {
    for (const call of calls) {
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "latency_ms",
      ])
        if (!Number.isFinite(call[key] ?? 0) || (call[key] ?? 0) < 0)
          throw Error(`Invalid LLM call ${key}`);
      db.prepare(
        `INSERT INTO llm_calls(evaluation_id,model,input_tokens,output_tokens,cost_usd,latency_ms,prompt,raw_response,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        call.model || model,
        call.input_tokens ?? 0,
        call.output_tokens ?? 0,
        call.cost_usd ?? 0,
        call.latency_ms ?? 0,
        typeof call.prompt === "string"
          ? call.prompt
          : JSON.stringify(call.prompt ?? null),
        typeof call.raw_response === "string"
          ? call.raw_response
          : JSON.stringify(call.raw_response ?? null),
        now(),
      );
    }
  };
  async function processItem(item) {
    const model = item.model;
    const evaluation = db
      .prepare("SELECT * FROM evaluations WHERE id=?")
      .get(item.evaluation_id);
    if (evaluation.status === "done") return; // COMMIT may have preceded the last job persist.
    const data = JSON.parse(evaluation.data);
    if (
      (pinned !== null && item.model !== pinned) || item.config_id !== configId ||
      item.prompt_key !==
        promptKey(getChecklist(db, evaluation.checklist_version_id))
    )
      throw Error(
        "модель/версия промпта/настройки оценки изменились с момента постановки; поставьте оценку заново",
      );
    const conversation = getConversation(db, evaluation.conversation_id),
      checklist = getChecklist(db, evaluation.checklist_version_id);
    if (item.transcript_source === "gemini") {
      const messages = alignTranscription(conversation.messages, item.transcript_items);
      if (transcriptHash(messages) !== item.transcript_hash)
        throw Error("Queued Gemini transcript no longer matches the original message positions");
      conversation.messages = messages;
    } else if (transcriptHash(conversation.messages) !== item.transcript_hash) {
      throw Error("Исходный текст изменился после постановки; поставьте оценку заново");
    }
    db.prepare("UPDATE evaluations SET status='running' WHERE id=?").run(
      evaluation.id,
    );
    const results = new Map(),
      missing = [];
    for (const c of checklist.criteria) {
      const key = cacheKey(checklist, c, item);
      // v23 leaves the initial Qwen rubric pass intact. Reuse v18 originals only
      // for unaffected criteria, with the same model, text and settings.
      const canReuseV18 = promptVersion === "v23" && model.startsWith("ollama/qwen") &&
        c.id !== "c06" && c.id !== "c07";
      const previousKey = canReuseV18 ? cacheKey(checklist, c, item, "v18") : key;
      const cached = db
        .prepare(
          `SELECT cr.original FROM criterion_results cr JOIN evaluations e ON e.id=cr.evaluation_id
    WHERE e.conversation_id=? AND e.status='done' AND cr.criterion_hash=? AND cr.prompt_version IN (?, ?) AND cr.model=? ORDER BY e.id DESC LIMIT 1`,
        )
        .get(
          conversation.conversation_id,
          c.hash,
          key,
          previousKey,
          model,
        );
      if (cached) {
        try {
          const result = { ...JSON.parse(cached.original), criterion_id: c.id };
          validateResult(c, result, conversation);
          results.set(c.id, result);
        } catch {
          missing.push(c);
        }
      } else missing.push(c);
    }
    db.prepare("UPDATE evaluations SET data=? WHERE id=?").run(
      JSON.stringify({
        ...data,
        evaluated_criteria: missing.map((c) => c.id),
        full_eval: missing.length === checklist.criteria.length,
      }),
      evaluation.id,
    );
    if (missing.length) {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await evaluate(
            conversation,
            missing,
            {
              ...checklist,
              prompt_version: promptVersion,
              model,
            },
            { noCache: true, config },
          );
          logCalls(evaluation.id, response?.calls, model);
          if (!Array.isArray(response?.results))
            throw Object.assign(Error("AI results must be an array"), {
              invalidResult: true,
            });
          try {
            if (
              response.results.length !== missing.length ||
              new Set(response.results.map((r) => r.criterion_id)).size !==
                missing.length
            )
              throw Error("Missing or duplicate AI criteria");
            for (const c of missing) {
              const result = response.results.find(
                (r) => r.criterion_id === c.id,
              );
              validateResult(c, result, conversation);
              results.set(c.id, result);
            }
          } catch (error) {
            error.invalidResult = true;
            throw error;
          }
          break;
        } catch (error) {
          if (error.calls) logCalls(evaluation.id, error.calls, model);
          if (
            error.retryable !== true ||
            error.invalidResult ||
            attempt >= retries
          )
            throw error;
          await sleep(backoff * 2 ** attempt);
        }
      }
    }
    transaction(db, () => {
      const insert = db.prepare(
        "INSERT INTO criterion_results VALUES (?,?,?,?,?,?,?)",
      );
      for (const c of checklist.criteria) {
        const result = JSON.stringify(results.get(c.id));
        insert.run(
          evaluation.id,
          c.id,
          c.hash,
          cacheKey(checklist, c, item),
          model,
          result,
          result,
        );
      }
      db.prepare("UPDATE evaluations SET status='done' WHERE id=?").run(
        evaluation.id,
      );
      getEvaluation(db, evaluation.id); // Validate the complete persisted score before committing.
    });
  }
  function pump() {
    while (!closing && active < concurrency && queue.length) {
      const { job, item } = queue.shift();
      active++;
      item.status = "running";
      job.status = "running";
      persist(job);
      processItem(item)
        .then(
          () => {
            item.status = "done";
          },
          (error) => {
            item.status = "error";
            job.errors.push({
              conversation_id: item.conversation_id,
              error: error.message,
            });
            db.prepare(
              "UPDATE evaluations SET status='error',data=? WHERE id=?",
            ).run(
              JSON.stringify({
                ...JSON.parse(
                  db
                    .prepare("SELECT data FROM evaluations WHERE id=?")
                    .get(item.evaluation_id).data,
                ),
                error: error.message,
              }),
              item.evaluation_id,
            );
          },
        )
        .finally(() => {
          job.done++;
          active--;
          if (job.done === job.total)
            job.status = job.errors.length ? "error" : "done";
          persist(job);
          pump();
        });
    }
  }
  // Resume unfinished work on restart. Completed evaluations and cache entries survive.
  for (const row of db.prepare("SELECT data FROM jobs").all()) {
    const job = JSON.parse(row.data);
    jobs.set(job.id, job);
    for (const item of job.items)
      if (["queued", "running"].includes(item.status)) {
        item.status = "queued";
        queue.push({ job, item });
      }
  }
  queueMicrotask(pump);
  function enqueue(items, versionId, checklist) {
    if (closing) throw fail(503, "Queue is shutting down");
    const job = {
      id: randomUUID(),
      status: items.length ? "queued" : "done",
      done: 0,
      total: items.length,
      errors: [],
      items: [],
    };
    const model = currentModel();
    transaction(db, () => {
      job.items = items.map(({ id, transcript_items, ...provenance }) => {
        const data = { prompt_key: promptKey(checklist), config_id: configId, evaluation_config: config, ...provenance };
        return {
          conversation_id: id,
          evaluation_id: createEvaluation(db, id, versionId, model, data),
          model,
          ...data,
          ...(transcript_items ? { transcript_items } : {}),
          status: "queued",
        };
      });
      persist(job);
    });
    jobs.set(job.id, job);
    for (const item of job.items) queue.push({ job, item });
    queueMicrotask(pump);
    return { job_id: job.id };
  }

  return {
    submit(body) {
      if (closing) throw fail(503, "Queue is shutting down");
      const { transcript_source: source = "original" } = body ?? {};
      if (source !== "original" && source !== "gemini")
        throw fail(400, "transcript_source must be original or gemini");
      const versionId = positiveId(
        body?.checklist_version_id,
        "checklist_version_id",
      );
      const checklist = getChecklist(db, versionId);
      if (!checklist) throw fail(404, "Checklist not found");
      const ids =
        body.conversation_ids === "all"
          ? db
              .prepare(
                "SELECT conversation_id FROM conversations ORDER BY conversation_id",
              )
              .all()
              .map((r) => r.conversation_id)
          : body.conversation_ids;
      if (
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw fail(400, "conversation_ids must be a unique array or all");
      const conversations = ids.map((id) => {
        const conversation = getConversation(db, id);
        if (!conversation) throw fail(404, `Conversation ${id} not found`);
        return conversation;
      });
      const items = conversations.map((conversation) => ({
        id: conversation.conversation_id,
        transcript_source: "original",
        transcription_model: null,
        transcript_hash: transcriptHash(conversation.messages),
      }));
      const voices = source === "gemini"
        ? conversations.filter((conversation) => conversation.channel === "voice call")
        : [];
      if (!voices.length) return enqueue(items, versionId, checklist);
      return (async () => {
        const resolved = new Map();
        for (const conversation of voices) {
          const id = conversation.conversation_id;
          const result = await options.resolveTranscription?.(conversation);
          const unavailable = () => fail(409, `Gemini transcription is missing or stale for ${id}`);
          if (typeof result?.model !== "string" || !result.model)
            throw unavailable();
          let messages;
          try {
            messages = alignTranscription(conversation.messages, result.messages);
          } catch {
            throw unavailable();
          }
          resolved.set(id, {
            id,
            transcript_source: "gemini",
            transcription_model: result.model,
            transcript_hash: transcriptHash(messages),
            transcript_items: messages.map(({ id, text }) => ({ id, text })),
          });
        }
        return enqueue(items.map((item) => resolved.get(item.id) ?? item), versionId, checklist);
      })();
    },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw fail(404, "Job not found");
      return {
        status: job.status,
        done: job.done,
        total: job.total,
        errors: structuredClone(job.errors),
      };
    },
    async close() {
      closing = true;
      while (active) await sleep(10);
    },
  };
}
