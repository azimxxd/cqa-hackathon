import { Router } from "express";
export function jobRoutes(jobs) {
  const router = Router();
  router.post("/evaluate", (req, res) =>
    res.status(202).json(jobs.submit(req.body)),
  );
  router.get("/jobs/:id", (req, res) => res.json(jobs.get(req.params.id)));
  return router;
}
