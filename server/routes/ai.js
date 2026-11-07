import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { registerEndpoint } from "../../ai/router.js";
import { asyncRoute, fail } from "../http.js";

// The GPU box announces its current tunnel URL here. Disabled unless OLLAMA_REGISTER_TOKEN is set.
export function aiRoutes() {
  const router = Router();
  router.post("/ai/ollama-endpoint", asyncRoute(async (req, res) => {
    const secret = process.env.OLLAMA_REGISTER_TOKEN || "";
    if (!secret) throw fail(404, "Route not found");
    const given = Buffer.from(String(req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw fail(401, "Unauthorized");
    res.json(await registerEndpoint(req.body?.url));
  }));
  return router;
}
