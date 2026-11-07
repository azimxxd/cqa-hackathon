import { Router } from "express";
import { asyncRoute } from "../http.js";
export function jobRoutes(jobs) {
  const router = Router();
  router.post("/evaluate", asyncRoute(async (req, res) => {
    res.status(202).json(await jobs.submit(req.body));
  }));
  router.get("/jobs/:id", (req, res) => res.json(jobs.get(req.params.id)));
  return router;
}
