import { randomUUID } from "node:crypto";
import { evaluateConversation } from "../ai/evaluate.js";
import { getChecklist, now, transaction } from "./db.js";
import { getConversation } from "./import.js";
import { createEvaluation, getEvaluation } from "./evaluations.js";
import { validateResult } from "./scoring.js";
import { fail, positiveId } from "./http.js";

// Explicit opt-in only. Fake results are labelled and isolated from the real model cache.
export async function fakeEvaluate(conversation, criteria) {
  const range = conversation.messages.length
    ? { from: conversation.messages[0].id, to: conversation.messages.at(-1).id }
    : null;
  const results = criteria.map((c) => ({
    criterion_id: c.id,
    answer: c.type === "scale" ? null : "yes",
    scale_value:
      c.type === "scale" ? Math.max(...c.scale.map((s) => s.value)) : null,
    explanation:
      "FAKE: deterministic server test result; not an AI assessment.",
    evidence_ids: [],
    checked_range: range,
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createJobService(db, options = {}) {
  const fake = options.fake ?? process.env.CQA_FAKE_LLM === "1";
  const model =
    options.model ??
    (fake
      ? "fake"
      : process.env.LLM_PROVIDER === "ollama"
        ? process.env.OLLAMA_MODEL || "qwen2.5:14b"
        : process.env.GEMINI_MODEL || "gemini-2.5-flash");
  const promptVersion =
    options.promptVersion ?? process.env.PROMPT_VERSION ?? "v1";
  const evaluate =
    options.evaluate ?? (fake ? fakeEvaluate : evaluateConversation);
  const concurrency = Number(
    options.concurrency ?? process.env.LLM_CONCURRENCY ?? 6,
  );
  const retries = Number(options.retries ?? process.env.LLM_RETRIES ?? 3);
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
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
  const logCalls = (id, calls = []) => {
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
    const evaluation = db
      .prepare("SELECT * FROM evaluations WHERE id=?")
      .get(item.evaluation_id);
    const conversation = getConversation(db, evaluation.conversation_id),
      checklist = getChecklist(db, evaluation.checklist_version_id);
    db.prepare("UPDATE evaluations SET status='running' WHERE id=?").run(
      evaluation.id,
    );
    const results = new Map(),
      missing = [];
    for (const c of checklist.criteria) {
      const cached = db
        .prepare(
          `SELECT cr.original FROM criterion_results cr JOIN evaluations e ON e.id=cr.evaluation_id
    WHERE e.conversation_id=? AND e.status='done' AND cr.criterion_hash=? AND cr.prompt_version=? AND cr.model=? ORDER BY e.id DESC LIMIT 1`,
        )
        .get(conversation.conversation_id, c.hash, promptVersion, model);
      if (cached) {
        const result = { ...JSON.parse(cached.original), criterion_id: c.id };
        // Disabling N/A cannot invent a yes/no answer. Fail explicitly, without an LLM call.
        validateResult(c, result, conversation);
        results.set(c.id, result);
      } else missing.push(c);
    }
    if (missing.length) {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await evaluate(conversation, missing, {
            ...checklist,
            prompt_version: promptVersion,
            model,
          });
          logCalls(evaluation.id, response?.calls);
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
          if (error.calls) logCalls(evaluation.id, error.calls);
          const status = Number(
            error.status ?? error.statusCode ?? error.response?.status,
          );
          const retryable =
            status === 429 ||
            status >= 500 ||
            ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error.code) ||
            error.invalidResult;
          if (
            !retryable ||
            attempt >= retries ||
            (error.invalidResult && attempt >= 1)
          )
            throw error;
          await sleep(backoff * 2 ** attempt);
        }
      }
    }
    transaction(db, () => {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO criterion_results VALUES (?,?,?,?,?,?,?)",
      );
      for (const c of checklist.criteria) {
        const result = JSON.stringify(results.get(c.id));
        insert.run(
          evaluation.id,
          c.id,
          c.hash,
          promptVersion,
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
            ).run(JSON.stringify({ error: error.message }), item.evaluation_id);
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
  return {
    submit(body) {
      if (closing) throw fail(503, "Queue is shutting down");
      const versionId = positiveId(
        body.checklist_version_id,
        "checklist_version_id",
      );
      if (!getChecklist(db, versionId)) throw fail(404, "Checklist not found");
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
      for (const id of ids)
        if (!getConversation(db, id))
          throw fail(404, `Conversation ${id} not found`);
      const job = {
        id: randomUUID(),
        status: ids.length ? "queued" : "done",
        done: 0,
        total: ids.length,
        errors: [],
        items: [],
      };
      transaction(db, () => {
        job.items = ids.map((id) => ({
          conversation_id: id,
          evaluation_id: createEvaluation(db, id, versionId, model),
          status: "queued",
        }));
        persist(job);
      });
      jobs.set(job.id, job);
      for (const item of job.items) queue.push({ job, item });
      queueMicrotask(pump);
      return { job_id: job.id };
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
