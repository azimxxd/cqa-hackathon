import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateSubmission } from "../shared/submission.js";
import { datasetRecords } from "../eval/dataset.js";
const filename = process.argv[2];
const options = Object.fromEntries(process.argv.slice(3).map(arg => {
  const index = arg.indexOf("=");
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
const dataset = options.dataset?.toUpperCase();
if (!filename || !["DEV", "PROD"].includes(dataset)) {
  console.error("Usage: node scripts/validate-results.js results.json --dataset=DEV|PROD [--source=data/dev.json]");
  process.exit(2);
}
try {
  const sourceFile = resolve(options.source || `data/${dataset.toLowerCase()}.json`);
  if (!existsSync(sourceFile)) throw Error("Source dataset required to verify IDs and evidence: pass --source=FILE");
  const records = datasetRecords(JSON.parse(readFileSync(sourceFile, "utf8")));
  const expectedCount = dataset === "DEV" ? 65 : 10;
  const calls = records.filter(r => r.channel === "voice call").length;
  const chats = records.filter(r => r.channel === "agent chat").length;
  if (records.length !== expectedCount || calls !== (dataset === "DEV" ? 5 : 0) || chats !== (dataset === "DEV" ? 60 : 10))
    throw Error("Source dataset size or channel composition is not official");
  const turnCounts = new Map(records.map(record => {
    const transcript = record.transcript ?? record.messages;
    if (!Array.isArray(transcript)) throw Error(`Missing transcript for ${record.conversation_id}`);
    return [record.conversation_id, transcript.length];
  }));
  const errors = validateSubmission(JSON.parse(readFileSync(filename, "utf8")), {
    expectedCount, turnCounts, expectedIds: new Set(records.map(r => r.conversation_id)),
  });
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Valid CQA Results JSON 1.0; source IDs and evidence verified");
} catch (error) { console.error(error.message); process.exitCode = 1; }
