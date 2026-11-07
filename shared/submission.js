import { validateResult } from "../server/scoring.js";
import { modelName } from "../ai/evaluate.js";

export const OFFICIAL = [
  ["c01", "contact", "binary", 10, [true]],
  ["c02", "discovery", "binary", 15, [true, null]],
  ["c03", "identification", "binary", 20, [true, null]],
  ["c04", "consultation", "scale", 20, [0, 5, 10, 15, 20, null]],
  ["c05", "empathy", "binary", 15, [true]],
  ["c06", "dialogue", "scale", 15, [0, 4, 7, 10]],
  ["c07", "closure", "binary", 5, [true, null]],
  ["c08", "critical", "binary", 0, [true]],
];
const LABELS = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"];
// Match provenance labels, not substrings of real aliases such as ":latest".
const unverifiedModel = name => /(?:^|[\s,/+:._-])(?:fake|stub|test|mock|unknown)(?:$|[\s,/+:._-])/i.test(name);
export function officialChecklist(checklist) {
  if (!checklist || checklist.criteria?.length !== OFFICIAL.length) return false;
  const expected = DEFAULT_CHECKLIST;
  if (checklist.rounding !== expected.rounding || checklist.first_reaction_threshold_sec !== expected.first_reaction_threshold_sec) return false;
  return expected.criteria.every((e, i) => {
    const c = checklist.criteria[i];
    return c.id === e.id && c.section === e.section && c.title === e.title && c.type === e.type &&
      c.weight === e.weight && c.na_allowed === e.na_allowed && c.scores_points === e.scores_points &&
      c.description === e.description && c.na_condition === e.na_condition && c.gross_error === e.gross_error &&
      JSON.stringify(c.scale ?? null) === JSON.stringify(e.scale ?? null);
  });
}
function score(criteria) {
  const pts = criteria.slice(0, 7);
  const weighted = pts.filter(c => c.value !== null);
  const denom = weighted.reduce((n,c) => n + OFFICIAL[LABELS.indexOf(c.criterion_id)][3], 0);
  if (!denom) throw Error("Нет оцениваемых критериев");
  return Math.round((weighted.reduce((n,c) => {
    const spec = OFFICIAL[LABELS.indexOf(c.criterion_id)];
    const max = spec[2] === "binary" ? 1 : Math.max(...spec[4].filter(Number.isFinite));
    return n + spec[3] * Number(c.value) / max;
  },0) * 100 / denom + Number.EPSILON) * 100) / 100;
}
const metric = (id, r) => id === "c08" ? r.answer === "yes" : r.answer === "na" ? null : r.answer === "yes" ? true : r.answer === "no" ? false : r.scale_value;
export function validateSubmission(doc, { turnCounts = new Map(), expectedCount, expectedIds } = {}) {
  const errors=[];
  if (doc?.schema_version !== "1.0" || doc.team_name !== "Saw-cell" || !["local","external_api","hybrid"].includes(doc.model?.mode) || typeof doc.model?.name !== "string" || !doc.model.name.trim() || !Array.isArray(doc.results)) errors.push("invalid header");
  for (const r of doc?.results ?? []) {
    if (typeof r.conversation_id !== "string" || !r.conversation_id.trim()) errors.push("invalid conversation_id");
    if (r.status === "error") { if (typeof r.error !== "string" || !r.error.trim() || !Array.isArray(r.criteria) || r.criteria.length !== 0 || r.score !== null) errors.push(`${r.conversation_id}: invalid error result`); continue; }
    if (r.status !== "ok" || r.criteria?.length !== 8 || new Set(r.criteria.map(c=>c.criterion_id)).size !== 8) { errors.push(`${r.conversation_id}: expected 8 unique criteria`); continue; }
    for (let i=0;i<8;i++) { const c=r.criteria[i], s=OFFICIAL[i];
      const valid = s[2] === "binary" ? typeof c.value === "boolean" || (s[4].includes(null) && c.value === null) : s[4].some(v=>v===c.value);
      if (c.criterion_id!==LABELS[i] || !valid || typeof c.rationale!=="string" || !c.rationale.trim() || !Array.isArray(c.evidence_turns) || c.evidence_turns.some(t=>!Number.isInteger(t)||t<1||(turnCounts.has(r.conversation_id)&&t>turnCounts.get(r.conversation_id)))) errors.push(`${r.conversation_id}: invalid ${LABELS[i]}`);
    }
    try { if (r.score?.final_score !== score(r.criteria) || typeof r.score.critical_flag !== "boolean" || r.score.critical_flag !== r.criteria[7].value) errors.push(`${r.conversation_id}: invalid score`); } catch { errors.push(`${r.conversation_id}: cannot calculate score`); }
  }
  if (doc?.model?.name && unverifiedModel(doc.model.name)) errors.push("test or unverifiable model name");
  if (new Set((doc?.results??[]).map(r=>r.conversation_id)).size !== (doc?.results??[]).length) errors.push("duplicate conversation_id");
  if (expectedCount !== undefined && doc?.results?.length !== expectedCount) errors.push(`expected ${expectedCount} results`);
  if (expectedIds && (doc?.results?.length !== expectedIds.size || doc.results.some(row => !expectedIds.has(row.conversation_id))))
    errors.push("Result IDs do not match the source dataset");
  return errors;
}
export function buildSubmission(db, { dataset, group_id, checklist_version_id, source="final", team_name="Saw-cell" }) {
  if (team_name!=="Saw-cell" || !["DEV","PROD"].includes(dataset) || typeof group_id !== "string" || !group_id.trim() || !["original","final"].includes(source)) throw Object.assign(Error("Invalid submission parameters"),{status:400});
  const checklist = db.prepare("SELECT id,data FROM checklist_versions WHERE id=?").get(Number(checklist_version_id));
  if (!checklist) throw Object.assign(Error("Unknown checklist_version_id"),{status:400});
  const config=JSON.parse(checklist.data), conversations=db.prepare("SELECT conversation_id,channel FROM conversations WHERE group_id=? ORDER BY conversation_id").all(group_id);
  const trusted = db.prepare("SELECT conversation_id FROM official_group_members WHERE group_id=? ORDER BY conversation_id").all(group_id).map(x=>x.conversation_id);
  const wanted=dataset==="DEV"?65:10, channels=dataset==="DEV"?{chat:60,call:5}:{chat:10,call:0};
  const ids=conversations.map(c=>c.conversation_id), chat=conversations.filter(c=>c.channel==="agent chat").length, call=conversations.filter(c=>c.channel==="voice call").length;
  const trustedSet = new Set(trusted);
  const ready=conversations.length===wanted && trusted.length===wanted && ids.every(id=>trustedSet.has(id)) && chat===channels.chat && call===channels.call && new Set(ids).size===wanted && officialChecklist(config);
  const warnings=[];
  const rows=conversations.map(c=>{
    try {
    const e=db.prepare("SELECT id,status,model,data FROM evaluations WHERE conversation_id=? AND checklist_version_id=? ORDER BY id DESC LIMIT 1").get(c.conversation_id,Number(checklist_version_id));
    if (!e || e.status!=="done") {
      const cause = e ? JSON.parse(e.data).error : null;
      return {conversation_id:c.conversation_id,status:"error",criteria:[],score:null,error:typeof cause === "string" && cause.trim() ? cause : e?`Оценка ${e.status}`:"Оценка отсутствует"};
    }
    const results=db.prepare("SELECT criterion_id,original,final FROM criterion_results WHERE evaluation_id=? ORDER BY rowid").all(e.id);
    const conversation=db.prepare("SELECT id,idx FROM messages WHERE conversation_id=? ORDER BY idx").all(c.conversation_id);
    const byId=new Map(conversation.map(m=>[m.id,m.idx+1]));
    for (const criterion of config.criteria) {
      const stored = results.find(row => row.criterion_id === criterion.id);
      if (!stored) throw Error(`Missing ${criterion.id}`);
      validateResult(criterion, JSON.parse(stored[source]), { messages: conversation });
    }
    const criteria=OFFICIAL.map(([id,key],i)=>{ const row=results.find(x=>x.criterion_id===id); if(!row) throw Error(`Missing ${id}`); const r=JSON.parse(row[source]); const val=metric(id,r); const evidence=(r.evidence_ids??[]).map(x=>byId.get(x)); if(evidence.some(x=>!x)) throw Error(`Invalid evidence ${id}`); if(r.checked_range) { const a=byId.get(r.checked_range.from), b=byId.get(r.checked_range.to); if(!a||!b||a>b) throw Error(`Invalid checked_range ${id}`); if(r.answer==="no"){evidence.push(a); if(b!==a)evidence.push(b);} } if(r.answer==="no"&&!r.checked_range&&!config.criteria.find(x=>x.id===id)?.gross_error) throw Error(`Missing checked_range ${id}`); const reason=r.explanation; if(!reason?.trim()) throw Error(`Missing rationale ${id}`); return {criterion_id:LABELS[i],value:val,rationale:reason,evidence_turns:[...new Set(evidence)]}; });
    return {conversation_id:c.conversation_id,status:"ok",criteria,score:{final_score:score(criteria),critical_flag:criteria[7].value}};
    } catch(error) { return {conversation_id:c.conversation_id,status:"error",criteria:[],score:null,error:`Не удалось сформировать оценку: ${error.message}`}; }
  });
  const successful=rows.filter(r=>r.status==="ok"), modelNames=[...new Set(conversations.filter(c=>rows.find(r=>r.conversation_id===c.conversation_id)?.status==="ok").map(c=>db.prepare("SELECT model FROM evaluations WHERE conversation_id=? AND checklist_version_id=? ORDER BY id DESC LIMIT 1").get(c.conversation_id,Number(checklist_version_id))?.model).filter(Boolean))];
  const allModelNames=[...new Set(conversations.map(c=>db.prepare("SELECT model FROM evaluations WHERE conversation_id=? AND checklist_version_id=? ORDER BY id DESC LIMIT 1").get(c.conversation_id,Number(checklist_version_id))?.model).filter(Boolean))];
  const selectedModels = successful.length ? modelNames : allModelNames.length ? allModelNames : [modelName()];
  const modelText = selectedModels.join(", ") || "unknown";
  if (!successful.length) warnings.push("Нет успешных оценок; модель взята из фактических попыток, конфигурации или неизвестна.");
  if (unverifiedModel(modelText)) warnings.push("Обнаружена тестовая или неизвестная модель.");
  const modes=new Set(selectedModels.map(m=>m.startsWith("ollama/")?"local":"external_api"));
  const mode=modes.size>1?"hybrid":modes.has("local")?"local":"external_api";
  const doc={schema_version:"1.0",team_name,model:{mode,name:modelText},results:rows};
  const turns=new Map(conversations.map(c=>[c.conversation_id,db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(c.conversation_id).n]));
  const errors=validateSubmission(doc,{turnCounts:turns});
  if (trusted.length !== wanted || ids.length !== trusted.length || ids.some(id=>!trustedSet.has(id))) errors.push("Source IDs do not match the organizer import manifest");
  if (chat !== channels.chat || call !== channels.call || conversations.length !== wanted) errors.push("Dataset size or channel composition does not match the official group");
  if (!officialChecklist(config)) errors.push("Checklist version is incompatible with Results JSON 1.0");
  if (rows.length !== wanted || rows.some(row=>row.status !== "ok" && row.status !== "error")) errors.push("Invalid conversation result status");
  const fake=unverifiedModel(allModelNames.join(" ")||modelText)||successful.some(r=>!db.prepare("SELECT model FROM evaluations WHERE conversation_id=? AND checklist_version_id=? ORDER BY id DESC LIMIT 1").get(r.conversation_id,Number(checklist_version_id))?.model);
  return {ready:ready&&rows.length===wanted&&errors.length===0&&!fake,complete:rows.length===wanted,expected_count:wanted,actual_count:rows.length,channel_counts:{chat,call},source_ids:ids,checklist_version_id:Number(checklist_version_id),source,warnings,errors,document:doc};
}
import { readFileSync } from "node:fs";
const DEFAULT_CHECKLIST = JSON.parse(readFileSync(new URL("./checklist.default.json", import.meta.url), "utf8"));
