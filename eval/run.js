// Owner: Алдияр. Compares system evaluations with hand labels in eval/labels/*.json:
// per-criterion agreement and MAE of the total. Labels use the CriterionResult shape.
//
// Usage: npm run eval -- [--only p1-ru-001,p1-kz-003] [--limit 20] [--no-cache] [--concurrency 6]
// DEV data is cached in eval/data/dev.json (fetched from ORG_API_URL with group_id=DEV if missing).
// Model answers are cached in eval/.cache (AI_CACHE_DIR) so re-runs only pay for changed prompts.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { totalScore, grossError, labelOf } from './score.js';

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
      const { results, calls } = await evaluateConversation(rec, criteria, meta, { noCache: args['no-cache'] });
      rows.push({ id, results, calls });
      process.stdout.write('.');
    } catch (e) {
      rows.push({ id, error: e.message });
      process.stdout.write('E');
    }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- metrics
const perCrit = Object.fromEntries(criteria.map((c) => [c.id, { agree: 0, n: 0, misses: [] }]));
let absErr = 0, nTotal = 0, grossAgree = 0, nGross = 0;
const calls = rows.flatMap((r) => r.calls || []);
const details = [];
for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  if (row.error) { details.push({ id: row.id, error: row.error }); continue; }
  const gt = labels.get(row.id);
  for (const c of criteria) {
    const g = gt.find((x) => x.criterion_id === c.id);
    if (!g) continue;
    const pred = labelOf(row.results.find((x) => x.criterion_id === c.id), c);
    const exp = labelOf(g, c);
    perCrit[c.id].n++;
    if (pred === exp) perCrit[c.id].agree++;
    else perCrit[c.id].misses.push({ id: row.id, expected: exp, got: pred, explanation: row.results.find((x) => x.criterion_id === c.id)?.explanation, note: g.note });
  }
  const tp = totalScore(row.results, criteria, meta.rounding);
  const tg = totalScore(gt, criteria, meta.rounding);
  if (tp != null && tg != null) { absErr += Math.abs(tp - tg); nTotal++; }
  nGross++; if (grossError(row.results, criteria) === grossError(gt, criteria)) grossAgree++;
  details.push({ id: row.id, total_pred: tp, total_gt: tg });
}

const sum = (k) => calls.reduce((a, c) => a + (c[k] || 0), 0);
const evaluated = rows.filter((r) => !r.error && r.calls?.length).length;
const report = {
  at: new Date().toISOString(),
  model: modelName(),
  prompt_version: PROMPT_VERSION,
  conversations: ids.length,
  errors: rows.filter((r) => r.error).length,
  per_criterion: Object.fromEntries(Object.entries(perCrit).map(([k, v]) => [k, { accuracy: v.n ? +(v.agree / v.n).toFixed(3) : null, n: v.n }])),
  overall_criterion_accuracy: +(Object.values(perCrit).reduce((a, v) => a + v.agree, 0) / Math.max(1, Object.values(perCrit).reduce((a, v) => a + v.n, 0))).toFixed(3),
  total_mae: nTotal ? +(absErr / nTotal).toFixed(2) : null,
  gross_error_accuracy: nGross ? +(grossAgree / nGross).toFixed(3) : null,
  cost: {
    calls: calls.length,
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cost_usd: +sum('cost_usd').toFixed(4),
    avg_cost_per_eval_usd: evaluated ? +(sum('cost_usd') / evaluated).toFixed(5) : null,
    avg_latency_ms: calls.length ? Math.round(sum('latency_ms') / calls.length) : null,
    note: 'only uncached conversations are counted',
  },
  totals: details,
  misses: Object.fromEntries(Object.entries(perCrit).map(([k, v]) => [k, v.misses])),
};

const outDir = path.join(here, 'reports');
mkdirSync(outDir, { recursive: true });
const stamp = report.at.replace(/[:.]/g, '-');
writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2));

console.log('\nCriterion  accuracy   n');
for (const [k, v] of Object.entries(report.per_criterion)) console.log(`${k.padEnd(10)} ${String(v.accuracy).padEnd(9)}  ${v.n}`);
console.log(`overall    ${report.overall_criterion_accuracy}`);
console.log(`total MAE  ${report.total_mae}   gross-error acc ${report.gross_error_accuracy}   errors ${report.errors}`);
console.log(`cost       $${report.cost.cost_usd} for ${report.cost.calls} calls; ~$${report.cost.avg_cost_per_eval_usd}/evaluation; avg ${report.cost.avg_latency_ms} ms/call`);
for (const [k, list] of Object.entries(report.misses)) for (const m of list) console.log(`  ✗ ${k} ${m.id}: expected ${m.expected}, got ${m.got} — ${m.explanation?.slice(0, 140)}`);
console.log(`\nReport: eval/reports/${stamp}.json`);
