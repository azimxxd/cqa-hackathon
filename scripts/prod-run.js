// One command for the control run: import → sanity check → evaluate missing → export → validate.
// Usage: npm run prod -- --group_id=<exact id from organizers> [--dataset=PROD] [--checklist_version_id=1]
//        [--source=final] [--reevaluate=failed|all|none] [--output=results/prod/results.json]
// Never invents IDs or scores: every step stops on the first error.
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { evaluationConfig, configHash } from "../ai/config.js";
import { evaluationIsCurrent } from "../server/evaluation-freshness.js";
import { getChecklist } from "../server/db.js";
import { getConversation } from "../server/import.js";
import { openDatabase } from "../server/db.js";
import { importGroup } from "../server/import.js";
import { createJobService } from "../server/jobs.js";
import { buildSubmission, validateSubmission } from "../shared/submission.js";
import { compositionWarnings, datasetComposition, datasetRecords } from "../eval/dataset.js";
import { modelName, PROMPT_VERSION } from "../ai/evaluate.js";

const args = Object.fromEntries(process.argv.slice(2).map((x) => {
  const i = x.indexOf("=");
  return i < 0 ? [x.replace(/^--/, ""), "1"] : [x.slice(2, i), x.slice(i + 1)];
}));
const group = args.group_id?.trim();
const dataset = (args.dataset || "PROD").toUpperCase();
const reevaluate = args.reevaluate || "failed";
if (!group || !["DEV", "PROD"].includes(dataset) || !["failed", "all", "none"].includes(reevaluate)) {
  console.error("Usage: npm run prod -- --group_id=<id> [--dataset=PROD|DEV] [--reevaluate=failed|all|none]");
  process.exit(2);
}
const log = (step, info) => console.log(`[${step}] ${typeof info === "string" ? info : JSON.stringify(info)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = openDatabase();
let jobs;
try {
  if (process.env.CQA_FAKE_LLM === "1") throw Error("Test provider cannot produce a submission");
  const config = evaluationConfig();
  const model = modelName();
  // 1. Import and keep the exact organizer body for ID/evidence validation.
  let body;
  const fetchImpl = async (...a) => {
    const response = await fetch(...a);
    const text = await response.text();
    try { body = JSON.parse(text); } catch {}
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const imported = await importGroup(db, group, { fetchImpl });
  const records = datasetRecords(body);
  const sourceFile = resolve(`data/${dataset.toLowerCase()}-${group.replace(/[^\w.-]/g, "_")}.json`);
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, JSON.stringify(body));
  log("import", { group, imported, source: sourceFile });

  // 2. Composition sanity check (C1) — a wrong import must not eat the hour.
  const warnings = compositionWarnings(records, dataset);
  log("sanity", datasetComposition(records));
  if (warnings.length && !args.force) {
    console.error(`[sanity] unexpected composition for ${dataset}: ${warnings.join("; ")} (pass --force to continue)`);
    process.exitCode = 1;
  } else {
    // 3. Evaluate what is missing (or failed) with the provider from .env.
    const version = Number(args.checklist_version_id ||
      db.prepare("SELECT id FROM checklist_versions ORDER BY id DESC LIMIT 1").get()?.id);
    const latest = db.prepare(
      "SELECT id,status,model,data,created_at FROM evaluations WHERE conversation_id=? AND checklist_version_id=? ORDER BY id DESC LIMIT 1");
    const checklist = getChecklist(db, version);
    if (!checklist) throw Error("Unknown checklist version");
    const current = id => evaluationIsCurrent(latest.get(id, version), {
      model, promptVersion: PROMPT_VERSION, config, checklist, conversation: getConversation(db, id),
    });
    const ids = records.map((r) => r.conversation_id).filter((id) => {
      if (reevaluate === "all") return true;
      return reevaluate === "failed" ? !current(id) : false;
    });
    log("evaluate", { model: process.env.CQA_FAKE_LLM === "1" ? "fake" : modelName(), checklist_version_id: version, todo: ids.length });
    if (ids.length) {
      jobs = createJobService(db, { config });
      const { job_id } = await jobs.submit({ checklist_version_id: version, conversation_ids: ids });
      let state;
      do {
        await sleep(2000);
        state = jobs.get(job_id);
        process.stdout.write(`\r[evaluate] ${state.done}/${state.total} ${state.status}   `);
      } while (!["done", "error", "failed"].includes(state.status) && state.done < state.total);
      process.stdout.write("\n");
      if (state.errors.length) log("evaluate", { errors: state.errors.slice(0, 10) });
    }

    const stale = records.filter(r => {
      const row = latest.get(r.conversation_id, version);
      return row?.status === "done" ? !current(r.conversation_id) : !args["allow-errors"];
    }).map(r => r.conversation_id);
    if (stale.length) throw Error(`Submission has missing, failed or stale evaluations: ${stale.join(", ")}`);

    // 4. Export and 5. validate against the organizer source.
    const report = buildSubmission(db, { dataset, group_id: group, checklist_version_id: version,
      source: args.source || "final", team_name: "Saw-cell" });
    if (!report.ready) {
      console.error(JSON.stringify({ ready: false, errors: report.errors, warnings: report.warnings }, null, 2));
      process.exitCode = 1;
    } else {
      const out = resolve(args.output || `results/${dataset.toLowerCase()}/results.json`);
      mkdirSync(dirname(out), { recursive: true });

      const turnCounts = new Map(records.map((r) => [r.conversation_id, (r.transcript ?? r.messages).length]));
      const errors = validateSubmission(report.document, {
        expectedCount: records.length, turnCounts, expectedIds: new Set(records.map((r) => r.conversation_id)),
      });
      if (errors.length) throw Error(errors.join("\n"));
      const text = JSON.stringify(report.document, null, 2) + "\n";
      const provenance = {
        created_at: new Date().toISOString(), dataset, group_id: group, model,
        prompt_version: PROMPT_VERSION, config_id: configHash(config), evaluation_config: config,
        checklist_version_id: version, source: args.source || "final",
        result_sha256: createHash("sha256").update(text).digest("hex"),
        input_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        evaluations: records.map(r => {
          const row = latest.get(r.conversation_id, version);
          return { conversation_id: r.conversation_id, evaluation_id: row?.id ?? null,
            status: row?.status ?? "missing", model: row?.model ?? null, created_at: row?.created_at ?? null };
        }),
      };
      const atomic = (path, content) => {
        const temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, content, { flag: "wx" }); renameSync(temp, path);
      };
      atomic(out, text);
      atomic(`${out}.provenance.json`, JSON.stringify(provenance, null, 2) + "\n");
      log("export", `${out} — valid CQA Results JSON 1.0`);
      if (report.warnings?.length) log("export", { warnings: report.warnings });
    }
  }
} catch (error) {
  console.error(`[prod] ${error.message}`);
  process.exitCode = 1;
} finally {
  await jobs?.close();
  db.close();
}
