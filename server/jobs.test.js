import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase, getChecklist, saveChecklist } from "./db.js";
import { saveConversations } from "./import.js";
import { createJobService } from "./jobs.js";
import { getEvaluation } from "./evaluations.js";
const conversation = JSON.parse(
  readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
);
const mock = JSON.parse(
  readFileSync(new URL("../shared/mocks/evaluation.json", import.meta.url)),
);
async function finish(service, id) {
  for (let i = 0; i < 200; i++) {
    const job = service.get(id);
    if (["done", "error"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Job timeout");
}
test("queue retries, limits concurrency and reuses only unchanged criteria across versions", async () => {
  const db = openDatabase(":memory:");
  const ids = ["a", "b", "c"];
  saveConversations(
    db,
    ids.map((conversation_id) => ({ ...conversation, conversation_id })),
    "DEV",
  );
  let active = 0,
    max = 0,
    attempts = 0;
  const requested = [];
  const service = createJobService(db, {
    concurrency: 2,
    backoffMs: 1,
    model: "test",
    evaluate: async (c, criteria) => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(Error("rate limited"), {
          status: 429,
          retryable: true,
        });
      active++;
      max = Math.max(max, active);
      requested.push(criteria.map((c) => c.id));
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        results: criteria.map(
          (c) => mock.criteria.find((r) => r.criterion_id === c.id).original,
        ),
        calls: [
          {
            model: "test",
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.01,
            latency_ms: 5,
          },
        ],
      };
    },
  });
  try {
    const first = await finish(
      service,
      service.submit({ conversation_ids: "all", checklist_version_id: 1 })
        .job_id,
    );
    assert.equal(first.status, "done");
    assert.equal(first.done, 3);
    assert.equal(max, 2);
    assert.equal(attempts, 4);
    assert.equal(getEvaluation(db, 1).total, 77.69);
    const version = getChecklist(db);
    version.criteria[0].weight = 20;
    version.criteria[0].na_allowed = true;
    const second = saveChecklist(db, version);
    await finish(
      service,
      service.submit({ conversation_ids: ids, checklist_version_id: second.id })
        .job_id,
    );
    assert.equal(attempts, 4);
    assert.notEqual(getEvaluation(db, 4).total, 77.69);
    second.criteria[3].description += " Changed";
    const third = saveChecklist(db, second);
    await finish(
      service,
      service.submit({
        conversation_ids: ["a"],
        checklist_version_id: third.id,
      }).job_id,
    );
    assert.deepEqual(requested.at(-1), ["c04"]);
    assert.equal(attempts, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get().n, 4);
  } finally {
    await service.close();
    db.close();
  }
});
test("invalid AI answers are never retried by server or cached", async () => {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  let calls = 0;
  const service = createJobService(db, {
    backoffMs: 0,
    evaluate: async () => {
      calls++;
      return { results: [], calls: [] };
    },
  });
  try {
    const job = await finish(
      service,
      service.submit({ conversation_ids: "all", checklist_version_id: 1 })
        .job_id,
    );
    assert.equal(job.status, "error");
    assert.equal(calls, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM criterion_results").get().n,
      0,
    );
  } finally {
    await service.close();
    db.close();
  }
});

test("N/A policy changes reevaluate only invalid cached criteria without inventing answers", async () => {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  let calls = 0;
  const requested = [];
  const service = createJobService(db, {
    model: "test",
    evaluate: async (_c, criteria) => {
      calls++;
      requested.push(criteria.map((c) => c.id));
      return {
        results: criteria.map((c) => ({
          ...mock.criteria.find((r) => r.criterion_id === c.id).original,
          ...(!c.na_allowed && c.id === "c02" ? { answer: "yes" } : {}),
        })),
        calls: [],
      };
    },
  });
  try {
    await finish(
      service,
      service.submit({ conversation_ids: "all", checklist_version_id: 1 })
        .job_id,
    );
    const checklist = getChecklist(db);
    checklist.criteria[1].na_allowed = false;
    const version = saveChecklist(db, checklist);
    const job = await finish(
      service,
      service.submit({
        conversation_ids: "all",
        checklist_version_id: version.id,
      }).job_id,
    );
    assert.equal(job.status, "done");
    assert.deepEqual(requested[1], ["c02"]);
    assert.equal(calls, 2);
  } finally {
    await service.close();
    db.close();
  }
});

test("model and prompt version are independent cache boundaries", async () => {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  let calls = 0,
    service;
  const evaluate = async (_c, criteria) => {
    calls++;
    return {
      results: criteria.map(
        (c) => mock.criteria.find((r) => r.criterion_id === c.id).original,
      ),
      calls: [],
    };
  };
  try {
    for (const [model, promptVersion] of [
      ["a", "v1"],
      ["a", "v2"],
      ["b", "v2"],
      ["b", "v2"],
    ]) {
      service = createJobService(db, { model, promptVersion, evaluate });
      assert.equal(
        (
          await finish(
            service,
            service.submit({ conversation_ids: "all", checklist_version_id: 1 })
              .job_id,
          )
        ).status,
        "done",
      );
      await service.close();
    }
    assert.equal(calls, 3);
  } finally {
    await service?.close();
    db.close();
  }
});

test("cache reevaluates only c06 for a changed first-reaction threshold and disables AI cache", async () => {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  const requests = [];
  const service = createJobService(db, {
    model: "test",
    evaluate: async (_c, criteria, _meta, opts) => {
      assert.equal(opts?.noCache, true);
      requests.push(criteria.map((c) => c.id));
      return {
        results: criteria.map(
          (c) => mock.criteria.find((r) => r.criterion_id === c.id).original,
        ),
        calls: [],
      };
    },
  });
  try {
    await finish(
      service,
      service.submit({ conversation_ids: "all", checklist_version_id: 1 })
        .job_id,
    );
    const v = saveChecklist(db, {
      ...getChecklist(db),
      first_reaction_threshold_sec: 30,
    });
    assert.equal(
      (
        await finish(
          service,
          service.submit({
            conversation_ids: "all",
            checklist_version_id: v.id,
          }).job_id,
        )
      ).status,
      "done",
    );
    assert.deepEqual(
      requests.map((r) => r.length),
      [8, 1],
    );
    assert.deepEqual(requests[1], ["c06"]);
  } finally {
    await service.close();
    db.close();
  }
});

test("restart rejects queued jobs whose pinned model or prompt settings changed", async () => {
  for (const changed of [
    { model: "m2", promptVersion: "v1" },
    { model: "m1", promptVersion: "v9" },
  ]) {
    const db = openDatabase(":memory:");
    saveConversations(db, [conversation], "DEV");
    let service = createJobService(db, {
      fake: true,
      model: "m1",
      promptVersion: "v1",
    });
    const { job_id } = service.submit({
      conversation_ids: "all",
      checklist_version_id: 1,
    });
    await service.close();
    service = createJobService(db, { fake: true, ...changed });
    try {
      const job = await finish(service, job_id);
      assert.equal(job.status, "error");
      assert.match(job.errors[0].error, /модель\/версия промпта изменились/);
      const e = getEvaluation(db, 1);
      assert.equal(e.model, "m1");
      assert.equal(e.prompt_key, "v1|frt=180");
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM criterion_results").get().n,
        0,
      );
      assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 0);
    } finally {
      await service.close();
      db.close();
    }
  }
});

test("restart after evaluation commit preserves reviewed final even when job item was not persisted", async () => {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  let service = createJobService(db, { fake: true });
  try {
    const { job_id } = service.submit({
      conversation_ids: "all",
      checklist_version_id: 1,
    });
    await finish(service, job_id);
    await service.close();
    const final = {
      ...JSON.parse(
        db
          .prepare(
            "SELECT final FROM criterion_results WHERE evaluation_id=1 AND criterion_id=?",
          )
          .get("c01").final,
      ),
      answer: "no",
      checked_range: { from: "m004", to: "m004" },
      explanation: "reviewed",
    };
    db.prepare(
      "UPDATE criterion_results SET final=? WHERE evaluation_id=1 AND criterion_id=?",
    ).run(JSON.stringify(final), "c01");
    const job = JSON.parse(
      db.prepare("SELECT data FROM jobs WHERE id=?").get(job_id).data,
    );
    job.items[0].status = "running";
    job.done = 0;
    job.status = "running";
    db.prepare("UPDATE jobs SET data=? WHERE id=?").run(
      JSON.stringify(job),
      job_id,
    );
    service = createJobService(db, {
      fake: true,
      model: "different-after-commit",
    });
    assert.equal((await finish(service, job_id)).status, "done");
    assert.equal(
      getEvaluation(db, 1).criteria[0].final.explanation,
      "reviewed",
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 1);
  } finally {
    await service.close();
    db.close();
  }
});
