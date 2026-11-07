import { Router } from "express";
import { getChecklist, saveChecklist } from "../db.js";
import { fail, positiveId } from "../http.js";
export function validateChecklist(body) {
  const bad = () => {
    throw fail(400, "Invalid ChecklistVersion");
  };
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    !Array.isArray(body.sections) ||
    !Array.isArray(body.criteria) ||
    !body.criteria.length
  )
    bad();
  const sections = new Set();
  for (const s of body.sections) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !s.id ||
      sections.has(s.id) ||
      typeof s.title !== "string"
    )
      bad();
    sections.add(s.id);
  }
  const ids = new Set();
  for (const c of body.criteria) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !c.id ||
      ids.has(c.id) ||
      !sections.has(c.section) ||
      typeof c.title !== "string" ||
      typeof c.description !== "string" ||
      !["binary", "scale"].includes(c.type) ||
      !Number.isFinite(c.weight) ||
      c.weight < 0 ||
      typeof c.na_allowed !== "boolean" ||
      (c.na_allowed &&
        (typeof c.na_condition !== "string" || !c.na_condition.trim())) ||
      typeof c.scores_points !== "boolean" ||
      (c.na_condition != null && typeof c.na_condition !== "string") ||
      (c.gross_error != null && typeof c.gross_error !== "boolean")
    )
      bad();
    ids.add(c.id);
    if (
      c.type === "scale" &&
      (!Array.isArray(c.scale) ||
        !c.scale.length ||
        c.scale.some(
          (s) =>
            !s ||
            !Number.isFinite(s.value) ||
            s.value < 0 ||
            typeof s.label !== "string",
        ) ||
        Math.max(...c.scale.map((s) => s.value)) <= 0 ||
        new Set(c.scale.map((s) => s.value)).size !== c.scale.length)
    )
      bad();
  }
  if (body.rounding != null && body.rounding !== 2) bad();
  if (
    body.first_reaction_threshold_sec != null &&
    (!Number.isFinite(body.first_reaction_threshold_sec) ||
      body.first_reaction_threshold_sec < 0)
  )
    bad();
  return body;
}
export function checklistRoutes(db) {
  const router = Router();
  router.get("/checklists", (_req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,name,created_at FROM checklist_versions ORDER BY id DESC",
        )
        .all(),
    ),
  );
  router.get("/checklists/:id", (req, res) => {
    const id =
      req.params.id === "latest" ? "latest" : positiveId(req.params.id);
    const v = getChecklist(db, id);
    if (!v) throw fail(404, "Checklist not found");
    res.json(v);
  });
  router.post("/checklists", (req, res) =>
    res.status(201).json(saveChecklist(db, validateChecklist(req.body))),
  );
  return router;
}
