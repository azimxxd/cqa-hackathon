import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreEvaluation, scoreCriterion } from "./scoring.js";
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url)));
const checklist = load("checklist.default.json"),
  evaluation = load("mocks/evaluation.json");
test("official mock gives 77.69 with normalized weights and section totals", () => {
  const scored = scoreEvaluation(checklist, evaluation);
  assert.equal(scored.total, 77.69);
  assert.equal(scored.original_total, 77.69);
  for (let i = 0; i < 8; i++) {
    assert.equal(scored.criteria[i].points, evaluation.criteria[i].points);
    assert.equal(
      scored.criteria[i].effective_weight,
      evaluation.criteria[i].effective_weight,
    );
  }
  assert.deepEqual(scored.sections, evaluation.sections);
});
test("binary, scale and N/A validation", () => {
  const c = checklist.criteria[0];
  assert.equal(scoreCriterion(c, { answer: "yes" }).points, 10);
  assert.equal(scoreCriterion(c, { answer: "no" }).points, 0);
  assert.throws(() => scoreCriterion(c, { answer: "na" }));
  assert.equal(
    scoreCriterion(checklist.criteria[3], { answer: null, scale_value: 5 })
      .points,
    5,
  );
  assert.throws(() =>
    scoreCriterion(checklist.criteria[3], { answer: null, scale_value: 6 }),
  );
});
test("review changes final only; gross error never resets score even with a weight", () => {
  const changed = structuredClone(evaluation),
    list = structuredClone(checklist);
  changed.criteria[6].final = { ...changed.criteria[6].final, answer: "yes" };
  changed.criteria[7].final = { ...changed.criteria[7].final, answer: "yes" };
  list.criteria[7].weight = 100;
  list.criteria[7].scores_points = true;
  const score = scoreEvaluation(list, changed);
  assert.equal(score.total, 85.38);
  assert.equal(score.original_total, 77.69);
  assert.equal(score.gross_error, true);
  assert.equal(score.criteria[7].points, 0);
  list.criteria.forEach((c) => (c.weight = 0));
  assert.equal(scoreEvaluation(list, changed).total, null);
});
test("all N/A gives null and weight changes recalculate", () => {
  const c = { ...checklist.criteria[0], na_allowed: true, weight: 37 };
  const row = {
    criterion_id: c.id,
    original: { answer: "na" },
    final: { answer: "na" },
  };
  assert.equal(
    scoreEvaluation({ criteria: [c] }, { criteria: [row] }).total,
    null,
  );
  row.final = { answer: "yes" };
  const scored = scoreEvaluation({ criteria: [c] }, { criteria: [row] });
  assert.equal(scored.total, 100);
  assert.equal(scored.original_total, null);
  assert.equal(scored.criteria[0].effective_weight, 100);
});
