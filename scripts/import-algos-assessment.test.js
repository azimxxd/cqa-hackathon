import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { getEvaluation } from "../server/evaluations.js";
import { importAlgosAssessment } from "./import-algos-assessment.js";

function fixture() {
  const db = openDatabase(":memory:");
  const records = ["a", "b"].map(id => ({ conversation_id: id, channel: "agent chat", language: "RU", audio_url: null,
    transcript: [{ timestamp: "00:00", speaker: "client", text: "Вопрос" }, { timestamp: "00:01", speaker: "operator", text: "Ответ" }] }));
  const criteria = Array.from({ length: 8 }, (_, i) => ({ criterion_id: `c0${i + 1}`, answer: [3,5].includes(i) ? null : "yes",
    scale_value: i === 3 ? 15 : i === 5 ? 7 : null, explanation: "Модель обосновала оценку репликой m002.", evidence_ids: ["m002"], checked_range: null }));
  criteria[1].answer = "na"; criteria[2].answer = "na";
  const batches = [{ model: "gpt-6-luna", prompt_version: "saw-cell-algos-v1", results: records.map(c => ({ conversation_id: c.conversation_id, results: structuredClone(criteria) })) }];
  return { db, args: { dataset: { isSuccess: true, data: { dataset_group_id: "DEV", total_records: 2, records } }, batches, model: "gpt-6-luna", runId: "actual-task-id" } };
}
test("Algos import retains judgments, recomputes weighted NA score, preserves critical flag and is idempotent", () => {
  const { db, args } = fixture();
  try {
    const imported = importAlgosAssessment(db, args);
    assert.equal(imported.imported, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM official_group_members WHERE group_id='DEV'").get().n, 2);
    const evaluation = getEvaluation(db, imported.evaluation_ids[0]);
    assert.equal(evaluation.total, 85.38);
    assert.equal(evaluation.gross_error, true);
    assert.equal(evaluation.model, "gpt-6-luna");
    assert.equal(evaluation.usage_available, false);
    assert.equal(db.prepare("SELECT count(*) n FROM llm_calls").get().n, 0);
    assert.equal(importAlgosAssessment(db, args).unchanged, 2);
  } finally { db.close(); }
});
test("incomplete, duplicate, invented evidence and mismatched model batches leave no assessments behind", () => {
  for (const mutate of [
    a => a.batches[0].results.pop(),
    a => a.batches[0].results[1].conversation_id = "a",
    a => a.batches[0].results[0].results[0].evidence_ids = ["invented"],
    a => a.batches[0].results[0].results[0].explanation = "  ",
    a => a.batches[0].model = "fake",
  ]) {
    const { db, args } = fixture();
    try {
      mutate(args); assert.throws(() => importAlgosAssessment(db, args));
      assert.equal(db.prepare("SELECT count(*) n FROM evaluations").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM conversations").get().n, 0);
    } finally { db.close(); }
  }
});
