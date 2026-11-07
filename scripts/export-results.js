import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../server/db.js";
import { buildSubmission } from "../shared/submission.js";
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf("=");return [x.slice(2,i),x.slice(i+1)]}));
const dataset=(args.dataset||args.group_id||"").toUpperCase(), db=openDatabase();
try {
  const version=args.checklist_version_id||db.prepare("SELECT id FROM checklist_versions ORDER BY id DESC LIMIT 1").get()?.id;
  const report=buildSubmission(db,{dataset,group_id:args.group_id||dataset,checklist_version_id:version,source:args.source||"final",team_name:args.team_name||"Saw-cell"});
  if(!report.ready) { console.error(JSON.stringify({ready:false,errors:report.errors,warnings:report.warnings,expected_count:report.expected_count,actual_count:report.actual_count,channel_counts:report.channel_counts},null,2)); process.exitCode=1; }
  else {const out=resolve(args.output||`results/${dataset.toLowerCase()}/results.json`);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report.document,null,2)+"\n");console.log(out);}
} finally { db.close(); }
