import { Router } from "express";
import { getEvaluation } from "../evaluations.js";
import { fail, positiveId } from "../http.js";
export function evaluationRoutes(db) {
  const router = Router();
  router.get("/evaluations", (req, res) => {
    const conditions = [],
      params = [];
    if (req.query.conversation_id) {
      conditions.push("conversation_id=?");
      params.push(req.query.conversation_id);
    }
    const version = req.query.checklist_version_id ?? req.query.version;
    if (version) {
      conditions.push("checklist_version_id=?");
      params.push(positiveId(version, "checklist_version_id"));
    }
    const row = db
      .prepare(
        `SELECT id FROM evaluations ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY id DESC LIMIT 1`,
      )
      .get(...params);
    if (!row) throw fail(404, "Evaluation not found");
    res.json(getEvaluation(db, row.id));
  });
  router.get("/evaluations/:id", (req,res) => {
    const evaluation = getEvaluation(db,positiveId(req.params.id));
    if (!evaluation) throw fail(404,"Evaluation not found");
    res.json(evaluation);
  });
  return router;
}
