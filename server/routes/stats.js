import { Router } from "express";
export function statsRoutes(db) {
  const router = Router();
  router.get("/stats", (_req, res) => {
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS calls,
  COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
  COALESCE(SUM(cost_usd),0) AS cost_usd,
  CASE WHEN COUNT(DISTINCT evaluation_id)>0 THEN SUM(cost_usd)/COUNT(DISTINCT evaluation_id) ELSE 0 END AS avg_cost_per_eval,
  COALESCE(AVG(latency_ms),0) AS avg_latency_ms FROM llm_calls`,
      )
      .get();
    const evaluations_done = db
      .prepare("SELECT COUNT(*) n FROM evaluations WHERE status='done'")
      .get().n;
    const evaluations_with_calls = db
      .prepare("SELECT COUNT(DISTINCT evaluation_id) n FROM llm_calls")
      .get().n;
    const avg_cost_per_full_eval = db
      .prepare(
        `SELECT COALESCE(AVG(cost),0) avg FROM (
      SELECT SUM(l.cost_usd) cost FROM evaluations e JOIN llm_calls l ON l.evaluation_id=e.id
      WHERE json_extract(e.data,'$.full_eval')=1 GROUP BY e.id
    )`,
      )
      .get().avg;
    res.json({
      ...stats,
      evaluations_done,
      evaluations_with_calls,
      avg_cost_per_full_eval,
    });
  });
  return router;
}
