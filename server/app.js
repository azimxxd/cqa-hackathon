import { appealRoutes } from "./routes/appeals.js";
import { statsRoutes } from "./routes/stats.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { conversationRoutes } from "./routes/conversations.js";
import { checklistRoutes } from "./routes/checklists.js";
import { evaluationRoutes } from "./routes/evaluations.js";
import { createJobService } from "./jobs.js";
import { jobRoutes } from "./routes/jobs.js";
import { submissionRoutes } from "./routes/submission.js";
import { transcriptionRoutes } from "./routes/transcription.js";
export function createApp(db, options = {}) {
  const transcription = transcriptionRoutes(db, options.transcription);
  const jobs = createJobService(db, {
    ...options.jobs,
    resolveTranscription: transcription.resolveTranscription,
  });

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.locals.jobs = jobs;
  app.locals.transcription = transcription;
  app.use("/api", jobRoutes(jobs), appealRoutes(db), statsRoutes(db));
  app.use(
    "/api",
    transcription.router,
    conversationRoutes(db),
    checklistRoutes(db),
    evaluationRoutes(db),
    submissionRoutes(db),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Route not found" }),
  );
  app.use(express.static(fileURLToPath(new URL("../web", import.meta.url))));
  app.use((err, _req, res, _next) =>
    res.status(err.status || 500).json({
      error: err.status ? err.message : "Internal server error",
      ...(err.conflict_ids ? { conflict_ids: err.conflict_ids } : {}),
    }),
  );
  return app;
}
