import { Router } from "express";
export function statsRoutes(db) {
  const router = Router();
  router.get("/stats", (_req, res) =>
    res.json(
      db
        .prepare(
          `SELECT COUNT(*) AS calls,
  COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
  COALESCE(SUM(cost_usd),0) AS cost_usd,
  CASE WHEN COUNT(DISTINCT evaluation_id)>0 THEN SUM(cost_usd)/COUNT(DISTINCT evaluation_id) ELSE 0 END AS avg_cost_per_eval,
  COALESCE(AVG(latency_ms),0) AS avg_latency_ms FROM llm_calls`,
        )
        .get(),
    ),
  );
  return router;
}
