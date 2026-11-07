import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-helpers.js";
import { createEvaluation } from "./evaluations.js";
test("statistics aggregate actual logged calls, tokens, cost and per-evaluation average", () =>
  fixture(async (request, db) => {
    assert.deepEqual((await request("/stats")).body, {
      calls: 0,
      tokens: 0,
      cost_usd: 0,
      avg_cost_per_eval: 0,
      avg_latency_ms: 0,
    });
    const first = createEvaluation(db, "mock-ru-001", 1, "test"),
      second = createEvaluation(db, "mock-ru-001", 1, "test");
    const insert = db.prepare(
      "INSERT INTO llm_calls(evaluation_id,model,input_tokens,output_tokens,cost_usd,latency_ms,created_at) VALUES (?,?,?,?,?,?,?)",
    );
    insert.run(first, "test", 100, 20, 0.1, 100, new Date().toISOString());
    insert.run(first, "test", 50, 10, 0.2, 300, new Date().toISOString());
    insert.run(second, "test", 200, 40, 0.3, 200, new Date().toISOString());
    const stats = (await request("/stats")).body;
    assert.equal(stats.calls, 3);
    assert.equal(stats.tokens, 420);
    assert.ok(Math.abs(stats.cost_usd - 0.6) < 1e-12);
    assert.ok(Math.abs(stats.avg_cost_per_eval - 0.3) < 1e-12);
    assert.equal(stats.avg_latency_ms, 200);
  }));
