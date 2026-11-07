import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase, getChecklist, saveChecklist } from "./db.js";
import { saveConversations } from "./import.js";
import { createJobService } from "./jobs.js";
import { getEvaluation } from "./evaluations.js";
import {
  evaluateConversation,
  PROMPT_VERSION,
  modelName,
} from "../ai/evaluate.js";
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url)));
const conversation = load("mocks/conversation.json");
const mock = load("mocks/evaluation.json");
export async function finish(service, id) {
  for (let i = 0; i < 1000; i++) {
    const job = service.get(id);
    if (["done", "error"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Job timeout");
}
async function scenario(id, mutate, check, options = {}) {
  const previousFetch = globalThis.fetch;
  const keys = [
    "GEMINI_API_KEY",
    "AI_CACHE_DIR",
    "LLM_PROVIDER",
    "CQA_FAKE_LLM",
    "GEMINI_MAX_ATTEMPTS",
    "GEMINI_MAX_BACKOFF_MS",
    "PROMPT_VERSION",
  ];
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GEMINI_API_KEY = "stub";
  process.env.LLM_PROVIDER = "gemini";
  process.env.CQA_FAKE_LLM = "0";
  process.env.GEMINI_MAX_ATTEMPTS = "2";
  process.env.GEMINI_MAX_BACKOFF_MS = "1";
  delete process.env.AI_CACHE_DIR;
  const requests = [];
  const db = openDatabase(":memory:");
  let service;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), init, body });
    const ids =
      body.generationConfig.responseSchema.properties.results.items.properties
        .criterion_id.enum;
    const results = ids.map((id) => {
      const r = structuredClone(
        mock.criteria.find((c) => c.criterion_id === id).original,
      );
      const range = r.checked_range;
      delete r.checked_range;
      return {
        ...r,
        checked_from: range?.from ?? null,
        checked_to: range?.to ?? null,
      };
    });
    mutate?.(results, requests.length);
    if (options.rateLimit)
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    return Response.json({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ results }) }] } },
      ],
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 50,
      },
    });
  };
  try {
    saveConversations(db, [{ ...conversation, conversation_id: id }], "STUB");
    if (options.prewarm)
      await evaluateConversation(
        { ...conversation, conversation_id: id },
        getChecklist(db).criteria,
        getChecklist(db),
      );
    service = createJobService(db, {
      retries: options.retries ?? 0,
      backoffMs: 0,
    });
    const run = async (version = 1) =>
      finish(
        service,
        service.submit({
          conversation_ids: "all",
          checklist_version_id: version,
        }).job_id,
      );
    const job = await run();
    await check({ job, db, requests, run, service });
  } finally {
    await service?.close();
    db.close();
    globalThis.fetch = previousFetch;
    for (const k of keys)
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  }
}
test("integration: real AI produces 77.69 and logs usage with secure temperature-zero request", () =>
  scenario("int-valid", null, ({ job, db, requests }) => {
    assert.equal(job.status, "done");
    assert.equal(getEvaluation(db, 1).total, 77.69);
    const calls = db.prepare("SELECT * FROM llm_calls").all();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].cost_usd > 0);
    assert.equal(calls[0].output_tokens, 150);
    assert.equal(requests[0].body.generationConfig.temperature, 0);
    assert.equal(requests[0].init.headers["x-goog-api-key"], "stub");
    assert.ok(!requests[0].url.includes("key="));
  }));
test("integration: bad scale gets exactly one retry with validation feedback", () =>
  scenario(
    "int-repair",
    (rs, n) => {
      if (n === 1) rs.find((r) => r.criterion_id === "c04").scale_value = 13;
    },
    ({ job, db, requests }) => {
      assert.equal(job.status, "done");
      assert.equal(requests.length, 2);
      assert.match(
        requests[1].body.contents[0].parts[0].text,
        /<fix_previous_errors>[\s\S]*c04:[\s\S]*13/,
      );
      assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 2);
    },
  ));
test("integration: persistent invalid answers fail without invented or cached results", () =>
  scenario(
    "int-invalid",
    (rs) => {
      for (const r of rs) {
        if (r.criterion_id === "c04") r.scale_value = 13;
        if (r.criterion_id === "c01") r.answer = "na";
      }
    },
    ({ job, db, requests }) => {
      assert.equal(job.status, "error");
      assert.equal(requests.length, 2);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 2);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM criterion_results").get().n,
        0,
      );
      assert.match(job.errors[0].error, /c01|c04/);
    },
  ));
test("integration: gross-error no needs no checked range", () =>
  scenario(
    "int-gross",
    (rs) => {
      const r = rs.find((r) => r.criterion_id === "c08");
      if (r) r.checked_from = r.checked_to = null;
    },
    ({ job }) => assert.equal(job.status, "done"),
  ));
test("integration: reversed range is repaired by AI feedback", () =>
  scenario(
    "int-range",
    (rs, n) => {
      const r = rs.find((r) => r.criterion_id === "c07");
      if (r && n === 1) {
        r.checked_from = "m009";
        r.checked_to = "m007";
      }
    },
    ({ job, requests }) => {
      assert.equal(job.status, "done");
      assert.equal(requests.length, 2);
      assert.match(
        requests[1].body.contents[0].parts[0].text,
        /<fix_previous_errors>[\s\S]*checked_range/,
      );
    },
  ));
test("integration: string evidence is normalized without TypeError or lost log", () =>
  scenario(
    "int-evidence",
    (rs) => {
      const r = rs.find((r) => r.criterion_id === "c01");
      if (r) r.evidence_ids = "m004";
    },
    ({ job, db }) => {
      assert.equal(job.status, "done");
      assert.deepEqual(getEvaluation(db, 1).criteria[0].original.evidence_ids, [
        "m004",
      ]);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 1);
    },
  ));
test("integration: exhausted 429 has bounded provider and server retries and logs every HTTP attempt", () =>
  scenario(
    "int-429",
    null,
    ({ job, db, requests }) => {
      assert.equal(job.status, "error");
      assert.match(job.errors[0].error, /Gemini HTTP 429/);
      assert.equal(requests.length, 4);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 4);
    },
    { rateLimit: true, retries: 1 },
  ));

test("integration: server ignores AI memCache, imports AI model/version and invalidates old prompt keys", () =>
  scenario(
    "int-cache",
    null,
    async ({ db, requests, run, service }) => {
      assert.equal(requests.length, 2); // standalone AI cache was warm before the server request
      const rows = db
        .prepare("SELECT prompt_version,model FROM criterion_results")
        .all();
      assert.ok(
        rows.every(
          (r) =>
            r.prompt_version.startsWith(`${PROMPT_VERSION}|frt=`) &&
            r.model === modelName(),
        ),
      );
      assert.equal((await run()).status, "done");
      assert.equal(requests.length, 2);
      db.prepare("UPDATE criterion_results SET prompt_version=?").run(
        "old-ai-prompt|frt=180",
      );
      assert.equal((await run()).status, "done");
      assert.equal(requests.length, 3);
      const v = saveChecklist(db, {
        ...getChecklist(db),
        first_reaction_threshold_sec: 30,
      });
      assert.equal((await run(v.id)).status, "done");
      assert.deepEqual(
        requests.at(-1).body.generationConfig.responseSchema.properties.results
          .items.properties.criterion_id.enum,
        ["c06"],
      );
      await service.close();
      const next = createJobService(db, {
        promptVersion: `${PROMPT_VERSION}-next`,
        retries: 0,
      });
      try {
        assert.equal(
          (
            await finish(
              next,
              next.submit({
                conversation_ids: "all",
                checklist_version_id: v.id,
              }).job_id,
            )
          ).status,
          "done",
        );
        assert.equal(requests.length, 5);
      } finally {
        await next.close();
      }
    },
    { prewarm: true },
  ));
