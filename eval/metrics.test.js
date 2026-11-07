import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMetrics } from "./metrics.js";
const load = (n) =>
  JSON.parse(readFileSync(new URL(`../shared/${n}`, import.meta.url)));
const checklist = load("checklist.default.json"),
  results = load("mocks/evaluation.json").criteria.map((r) => r.original);
test("metrics count provider errors as misses and match full-evaluation cost including failed calls", () => {
  const all = checklist.criteria.map((c) => c.id),
    labels = new Map(
      ["full", "failed", "partial", "cached"].map((id) => [id, results]),
    );
  const rows = [
    {
      id: "full",
      results,
      calls: [{ cost_usd: 0.1 }, { cost_usd: 0.2 }],
      evaluated_criteria: all,
      cached_count: 0,
    },
    {
      id: "failed",
      error: "invalid result",
      calls: [{ cost_usd: 0.3 }, { cost_usd: 0.4 }],
      evaluated_criteria: all,
      cached_count: 0,
    },
    {
      id: "partial",
      results,
      calls: [{ cost_usd: 0.9 }],
      evaluated_criteria: ["c06"],
      cached_count: 7,
    },
    {
      id: "cached",
      results,
      calls: [],
      evaluated_criteria: [],
      cached_count: 8,
    },
  ];
  const report = buildMetrics(rows, labels, checklist.criteria);
  assert.equal(report.errors, 1);
  assert.equal(report.cached_answers, 15);
  assert.equal(report.overall_criterion_accuracy, 0.75);
  for (const c of checklist.criteria)
    assert.deepEqual(report.per_criterion[c.id], { accuracy: 0.75, n: 4 });
  assert.equal(report.cost.full_evaluations_with_calls, 2);
  assert.equal(report.cost.avg_cost_per_eval_usd, 0.5);
  assert.equal(report.cost.evaluations_with_calls, 3);
  assert.equal(report.cost.calls, 5);
  assert.equal(report.cost.cost_usd, 1.9);
  assert.equal(report.total_mae, 0);
  assert.equal(report.gross_error_accuracy, 0.75);
});
