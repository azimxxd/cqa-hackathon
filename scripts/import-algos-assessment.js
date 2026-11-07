// Import actual, already completed Algos judgments. This does not generate scores.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, getChecklist, transaction } from "../server/db.js";
import { normalizeConversation, saveConversations } from "../server/import.js";
import { createEvaluation, getEvaluation } from "../server/evaluations.js";
import { validateResult } from "../server/scoring.js";

export function importAlgosAssessment(db, { dataset, batches, model, runId, version = 1 }) {
  if (!model?.startsWith("gpt-") || !runId?.trim()) throw Error("Actual model and Algos run ID are required");
  if (dataset?.isSuccess !== true || !Array.isArray(dataset.data?.records) || !dataset.data.records.length)
    throw Error("Expected a nonempty organizer dataset envelope");
  const group = dataset.data.dataset_group_id;
  if (typeof group !== "string" || !group.trim()) throw Error("Dataset group is required");
  const conversations = dataset.data.records.map(normalizeConversation);
  const byId = new Map(conversations.map(c => [c.conversation_id, c]));
  if (byId.size !== conversations.length) throw Error("Duplicate source conversation_id");
  if (dataset.data.total_records !== conversations.length) throw Error("Dataset count mismatch");
  const checklist = getChecklist(db, version);
  if (!checklist) throw Error("Checklist version not found");
  const expected = new Set(checklist.criteria.map(c => c.id));
  const promptVersion = batches[0]?.prompt_version;
  if (!["saw-cell-algos-v1", "saw-cell-algos-reviewed-v2"].includes(promptVersion))
    throw Error("Unknown assessment prompt version");
  const seen = new Set(), items = [];
  for (const batch of batches) {
    if (batch.model !== model || batch.prompt_version !== promptVersion || !Array.isArray(batch.results))
      throw Error("Batch model/prompt provenance mismatch");
    for (const row of batch.results) {
      const conversation = byId.get(row.conversation_id);
      if (!conversation || seen.has(row.conversation_id)) throw Error("Unknown or duplicate assessment conversation_id");
      seen.add(row.conversation_id);
      if (!Array.isArray(row.results) || row.results.length !== expected.size ||
          new Set(row.results.map(r => r.criterion_id)).size !== expected.size ||
          row.results.some(r => !expected.has(r.criterion_id))) throw Error(`Incomplete criteria: ${row.conversation_id}`);
      for (const criterion of checklist.criteria) {
        const result = row.results.find(r => r.criterion_id === criterion.id);
        try { validateResult(criterion, result, conversation); }
        catch (error) { throw Error(`${row.conversation_id}/${criterion.id}: ${error.message}`); }
        if (!result.explanation.trim() || !result.evidence_ids.length)
          throw Error(`Missing rationale/evidence: ${row.conversation_id}/${criterion.id}`);
      }
      const existing = db.prepare("SELECT group_id FROM conversations WHERE conversation_id=?").get(row.conversation_id);
      if (existing && existing.group_id !== group) throw Error("Conversation belongs to a different dataset group");
      items.push(row);
    }
  }
  if (seen.size !== byId.size) throw Error(`Assessment incomplete: ${seen.size}/${byId.size}`);
  const previousManifest = db.prepare("SELECT conversation_id FROM official_group_members WHERE group_id=?").all(group);
  if (previousManifest.length && (previousManifest.length !== byId.size || previousManifest.some(row => !byId.has(row.conversation_id))))
    throw Error("Cached source dataset differs from the existing organizer manifest");
  // Validate the entire set before writing any imported evaluation.
  saveConversations(db, dataset.data.records, group);
  const hash = createHash("sha256").update(JSON.stringify({ model, runId, promptVersion, version, items, conversations })).digest("hex");
  return transaction(db, () => {
    db.prepare("DELETE FROM official_group_members WHERE group_id=?").run(group);
    const member = db.prepare("INSERT INTO official_group_members(group_id,conversation_id) VALUES (?,?)");
    for (const id of byId.keys()) member.run(group, id);
    let imported = 0, unchanged = 0;
    const evaluationIds = [];
    for (const row of items) {
      const previous = db.prepare("SELECT id,data FROM evaluations WHERE conversation_id=? AND checklist_version_id=? AND status='done' ORDER BY id DESC").all(row.conversation_id, version)
        .find(e => JSON.parse(e.data).algos_import_hash === hash);
      if (previous) { unchanged++; evaluationIds.push(previous.id); continue; }
      const id = createEvaluation(db, row.conversation_id, version, model, {
        source: "algos", algos_run_id: runId, algos_import_hash: hash,
        prompt_version: promptVersion, usage_available: false,
        limitations: "Subscription model judgments; token usage, per-dialogue latency and API cost were not measured. No independent accuracy claim.",
      });
      const insert = db.prepare("INSERT INTO criterion_results VALUES (?,?,?,?,?,?,?)");
      for (const criterion of checklist.criteria) {
        const result = JSON.stringify(row.results.find(r => r.criterion_id === criterion.id));
        insert.run(id, criterion.id, criterion.hash, promptVersion, model, result, result);
      }
      db.prepare("UPDATE evaluations SET status='done' WHERE id=?").run(id);
      getEvaluation(db, id); // Independently calculate and validate the persisted score.
      imported++; evaluationIds.push(id);
    }
    return { imported, unchanged, total: items.length, group, model, evaluation_ids: evaluationIds, sha256: hash };
  });
}

function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--dataset", "--model", "--run", "--db", "--version"].includes(args[i]) || !args[i + 1])
      throw Error("Usage: node scripts/import-algos-assessment.js --input DIR --dataset data/dev.json --model MODEL --run ALGOS_TASK_ID [--db FILE] [--version 1]");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.input || !options.dataset) throw Error("--input and --dataset are required");
  const files = readdirSync(options.input).filter(f => /^batch-\d+\.json$/.test(f)).sort();
  if (!files.length) throw Error("No completed assessment batches found");
  const batches = files.map(f => JSON.parse(readFileSync(resolve(options.input, f), "utf8")));
  const dataset = JSON.parse(readFileSync(options.dataset, "utf8"));
  const db = openDatabase(options.db);
  try {
    console.log(JSON.stringify(importAlgosAssessment(db, { dataset, batches, model: options.model, runId: options.run, version: Number(options.version || 1) }), null, 2));
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
