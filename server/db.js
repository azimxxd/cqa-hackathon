import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const now = () => new Date().toISOString();
export const criterionHash = (c) =>
  createHash("sha1")
    .update(
      JSON.stringify([
        c.title,
        c.type,
        c.description,
        c.na_condition ?? null,
        c.scale ?? null,
      ]),
    )
    .digest("hex");
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function saveChecklist(db, input) {
  const { id: _id, created_at: _date, ...body } = input;
  const version = {
    ...body,
    created_at: now(),
    criteria: body.criteria.map((c) => ({ ...c, hash: criterionHash(c) })),
  };
  const result = db
    .prepare(
      "INSERT INTO checklist_versions(name, created_at, data) VALUES (?, ?, ?)",
    )
    .run(version.name, version.created_at, JSON.stringify(version));
  return { ...version, id: Number(result.lastInsertRowid) };
}
export function getChecklist(db, id = "latest") {
  const row =
    id === "latest"
      ? db
          .prepare("SELECT * FROM checklist_versions ORDER BY id DESC LIMIT 1")
          .get()
      : db.prepare("SELECT * FROM checklist_versions WHERE id = ?").get(id);
  if (!row) return null;
  const data = JSON.parse(row.data);
  return {
    ...data,
    id: row.id,
    criteria: data.criteria.map((c) => ({ ...c, hash: criterionHash(c) })),
  };
}
export function openDatabase(
  filename = process.env.CQA_DB_PATH ||
    fileURLToPath(new URL("../data/cqa.db", import.meta.url)),
) {
  if (filename !== ":memory:")
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, channel TEXT NOT NULL,
      language TEXT, audio_url TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS official_group_members (
      group_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      PRIMARY KEY(group_id, conversation_id));
    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id), id TEXT NOT NULL,
      idx INTEGER NOT NULL, timestamp TEXT NOT NULL, offset_sec REAL NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(conversation_id, id), UNIQUE(conversation_id, idx));
    CREATE TABLE IF NOT EXISTS checklist_versions (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
      checklist_version_id INTEGER NOT NULL REFERENCES checklist_versions(id), status TEXT NOT NULL,
      created_at TEXT NOT NULL, model TEXT, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS criterion_results (
      evaluation_id INTEGER NOT NULL REFERENCES evaluations(id), criterion_id TEXT NOT NULL,
      criterion_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL,
      original TEXT NOT NULL, final TEXT NOT NULL, PRIMARY KEY(evaluation_id, criterion_id));
    CREATE INDEX IF NOT EXISTS criterion_cache ON criterion_results(criterion_hash, prompt_version, model);
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY, evaluation_id INTEGER NOT NULL REFERENCES evaluations(id), model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, latency_ms REAL NOT NULL DEFAULT 0,
      prompt TEXT, raw_response TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS appeals (
      id INTEGER PRIMARY KEY, evaluation_id INTEGER NOT NULL, criterion_id TEXT NOT NULL,
      comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      FOREIGN KEY(evaluation_id, criterion_id) REFERENCES criterion_results(evaluation_id, criterion_id));
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_appeal ON appeals(evaluation_id, criterion_id) WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS review_decisions (
      id INTEGER PRIMARY KEY, appeal_id INTEGER NOT NULL UNIQUE REFERENCES appeals(id),
      action TEXT NOT NULL CHECK(action IN ('confirm', 'change')), new_answer TEXT,
      new_scale_value REAL, reason TEXT NOT NULL, decided_at TEXT NOT NULL);
  `);
  if (!getChecklist(db))
    saveChecklist(
      db,
      JSON.parse(
        readFileSync(
          new URL("../shared/checklist.default.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  return db;
}
