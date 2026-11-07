import { getChecklist, now } from "./db.js";
import { scoreEvaluation } from "./scoring.js";
export function getEvaluation(db, id) {
  const row = db.prepare("SELECT * FROM evaluations WHERE id=?").get(id);
  if (!row) return null;
  const data = JSON.parse(row.data);
  const criteria = db
    .prepare(
      `SELECT criterion_id, original, final FROM criterion_results WHERE evaluation_id=? ORDER BY rowid`,
    )
    .all(id)
    .map((r) => ({
      criterion_id: r.criterion_id,
      original: JSON.parse(r.original),
      final: JSON.parse(r.final),
      appealed: !!db
        .prepare(
          "SELECT 1 FROM appeals WHERE evaluation_id=? AND criterion_id=? LIMIT 1",
        )
        .get(id, r.criterion_id),
    }));
  const evaluation = {
    ...data,
    id: row.id,
    conversation_id: row.conversation_id,
    checklist_version_id: row.checklist_version_id,
    status: row.status,
    model: row.model,
    created_at: row.created_at,
    criteria,
    cost_usd: db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd),0) AS cost FROM llm_calls WHERE evaluation_id=?",
      )
      .get(id).cost,
  };
  return row.status === "done"
    ? scoreEvaluation(getChecklist(db, row.checklist_version_id), evaluation)
    : {
        ...evaluation,
        total: null,
        original_total: null,
        gross_error: false,
        sections: {},
      };
}
export function createEvaluation(db, conversationId, checklistId, model) {
  return Number(
    db
      .prepare(
        "INSERT INTO evaluations(conversation_id,checklist_version_id,status,created_at,model) VALUES (?,?,?,?,?)",
      )
      .run(conversationId, checklistId, "queued", now(), model).lastInsertRowid,
  );
}
