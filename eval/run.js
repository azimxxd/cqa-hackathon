// Owner: Алдияр. Compares system evaluations with hand labels in eval/labels/*.json:
// per-criterion agreement and MAE of the total. Labels use the CriterionResult shape.
//
// Usage: npm run eval -- [--only p1-ru-001,p1-kz-003] [--limit 20] [--no-cache] [--concurrency 6]
// DEV data is cached in data/dev.json (fetched from ORG_API_URL with group_id=DEV if missing).
// Model answers are cached in data/ai-cache (AI_CACHE_DIR) so re-runs only pay for changed prompts.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildMetrics } from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
process.env.AI_CACHE_DIR ??= path.join(root, 'data', 'ai-cache');
const { evaluateConversation, modelName, PROMPT_VERSION } = await import('../ai/evaluate.js');

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    limit: { type: 'string' },
    'no-cache': { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    group: { type: 'string', default: 'DEV' },
  },
});

async function loadDataset(group) {
  const file = path.join(root, 'data', `${group.toLowerCase()}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const base = process.env.ORG_API_URL;
  if (!base) throw new Error(`No ${file} and ORG_API_URL is not set`);
  const url = new URL(base);
  url.searchParams.set('group_id', group);
  const res = await fetch(url);
  const json = await res.json();
  if (!json.isSuccess) throw new Error(`API error: ${json.error}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json.data.records, null, 1));
  return json.data.records;
}

const checklist = JSON.parse(readFileSync(path.join(root, 'shared', 'checklist.default.json'), 'utf8'));
const criteria = checklist.criteria;
const meta = { first_reaction_threshold_sec: checklist.first_reaction_threshold_sec, rounding: checklist.rounding };

const records = await loadDataset(args.group);
const labelDir = path.join(here, 'labels');
const labels = new Map(readdirSync(labelDir).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(labelDir, f), 'utf8'))]));

let ids = [...labels.keys()].filter((id) => records.some((r) => r.conversation_id === id)).sort();
if (args.only) ids = ids.filter((id) => args.only.split(',').includes(id));
if (args.limit) ids = ids.slice(0, Number(args.limit));
if (!ids.length) { console.log('No labeled conversations found in eval/labels.'); process.exit(0); }

const conc = Number(args.concurrency || process.env.LLM_CONCURRENCY || 6);
console.log(`Evaluating ${ids.length} conversations with ${modelName()} (prompt ${PROMPT_VERSION}), concurrency ${conc}`);

const rows = [];
let next = 0;
const t0 = Date.now();
async function worker() {
  while (next < ids.length) {
    const id = ids[next++];
    const rec = records.find((r) => r.conversation_id === id);
    try {
      const response = await evaluateConversation(rec, criteria, meta, { noCache: args['no-cache'] });
      rows.push({ id, ...response });
      process.stdout.write('.');
    } catch (e) {
      rows.push({ id, error: e.message, calls:e.calls || [], cached_count:e.cached_count || 0, evaluated_criteria:e.evaluated_criteria || [] });
      process.stdout.write('E');
    }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const report = {
  at: new Date().toISOString(), model:modelName(),prompt_version:PROMPT_VERSION,
  ...buildMetrics(rows,labels,criteria),
};

const outDir = path.join(here, 'reports');
mkdirSync(outDir, { recursive: true });
const stamp = report.at.replace(/[:.]/g, '-');
writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2));

console.log('\nCriterion  accuracy   n');
for (const [k, v] of Object.entries(report.per_criterion)) console.log(`${k.padEnd(10)} ${String(v.accuracy).padEnd(9)}  ${v.n}`);
console.log(`overall    ${report.overall_criterion_accuracy}`);
console.log(`total MAE  ${report.total_mae}   gross-error acc ${report.gross_error_accuracy}   errors ${report.errors}; cached answers ${report.cached_answers}`);
console.log(`cost       $${report.cost.cost_usd} for ${report.cost.calls} calls; ~$${report.cost.avg_cost_per_eval_usd}/evaluation; avg ${report.cost.avg_latency_ms} ms/call`);
for (const [k, list] of Object.entries(report.misses)) for (const m of list) console.log(`  ✗ ${k} ${m.id}: expected ${m.expected}, got ${m.got} — ${m.explanation?.slice(0, 140)}`);
console.log(`\nReport: eval/reports/${stamp}.json`);
