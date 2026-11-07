import test from "node:test";
import assert from "node:assert/strict";
import { validateSubmission, officialChecklist } from "./submission.js";
import { openDatabase } from "../server/db.js";
import { saveConversations } from "../server/import.js";
import { buildSubmission } from "./submission.js";
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const labels=["contact","discovery","identification","consultation","empathy","dialogue","closure","critical"];
const row=(value,i)=>({criterion_id:labels[i],value:value[0]==="c06"?10:value[0]==="c04"?20:value[0]==="c08"?false:true,rationale:"Проверено по реплике",evidence_turns:[1]});
const doc=()=>{const criteria=[["c01"],["c02"],["c03"],["c04"],["c05"],["c06"],["c07"],["c08"]].map(row);return {schema_version:"1.0",team_name:"Saw-cell",model:{mode:"external_api",name:"gemini-3.5-flash"},results:[{conversation_id:"D-1",status:"ok",criteria,score:{final_score:100,critical_flag:false}}]};};
test("accepts exact official 8 criterion shape and rejects wrong score, bad refs and duplicates",()=>{
 assert.deepEqual(validateSubmission(doc()),[]);
 const bad=doc();bad.results[0].score.final_score=0;bad.results[0].criteria[5].evidence_turns=[0];
 assert.ok(validateSubmission(bad,{turnCounts:new Map([["D-1",3]])}).length>=2);
 const dup=doc();dup.results.push(dup.results[0]);assert.ok(validateSubmission(dup).some(x=>x.includes("duplicate")));
});
test("error result is explicit and cannot masquerade as a scored zero",()=>{
 const d=doc();d.results=[{conversation_id:"D-1",status:"error",criteria:[],score:null,error:"evaluation failed"}];assert.deepEqual(validateSubmission(d),[]);
 d.results[0].score={final_score:0,critical_flag:false};assert.ok(validateSubmission(d).length);
 const invalid=doc(); invalid.model.name="FAKE"; invalid.results=[{conversation_id:"D-1",status:"error",criteria:[],score:null,error:42}];
 assert.ok(validateSubmission(invalid).length>=2);
});
test("real latest model aliases are accepted while explicit FAKE provenance is refused", () => {
 const input=doc(); input.model={mode:"local",name:"ollama/qwen2.5:latest"};
 assert.deepEqual(validateSubmission(input), []);
 input.model.name="fake/test-model";
 assert.ok(validateSubmission(input).some(error=>error.includes("model")));
});
test("official checklist compatibility rejects semantic changes to N/A applicability",()=>{
 const db=openDatabase(":memory:");
 try {const checklist=JSON.parse(db.prepare("SELECT data FROM checklist_versions WHERE id=1").get().data);assert.equal(officialChecklist(checklist),true);checklist.criteria[1].na_condition="Всегда выставляй N/A";assert.equal(officialChecklist(checklist),false);}
 finally {db.close();}
});
test("PROD builder preserves failed rows as errors and refuses IDs outside imported source manifest",()=>{
 const db=openDatabase(":memory:");
 try {
  const ids=Array.from({length:10},(_,i)=>`prod-${i}`);
  const input=ids.map(conversation_id=>({conversation_id,channel:"agent chat",language:"ru",messages:[{speaker:"client",timestamp:"00:00",text:"Вопрос"}]}));
  saveConversations(db,input,"PROD");
  db.prepare("INSERT INTO official_group_members(group_id,conversation_id) VALUES ('PROD',?)").run("prod-0");
  for(const id of ids) db.prepare("INSERT INTO evaluations(conversation_id,checklist_version_id,status,created_at,model,data) VALUES (?,1,'failed','now','gemini-3.5-flash','{}')").run(id);
  const built=buildSubmission(db,{dataset:"PROD",group_id:"PROD",checklist_version_id:1});
  assert.equal(built.document.results.length,10);
  assert.ok(built.document.results.every(r=>r.status==="error"&&r.criteria.length===0&&r.score===null&&typeof r.error==="string"));
  assert.equal(built.ready,false);
  assert.ok(built.errors.some(x=>x.includes("manifest")));
 } finally {db.close();}
});
function seedReadyGroup(db, dataset, failureAt = -1) {
 const count=dataset==="DEV"?65:10;
 const rows=Array.from({length:count},(_,i)=>{const call=dataset==="DEV"&&i>=60;return {conversation_id:`${dataset}-${i}`,channel:call?"voice call":"agent chat",language:"ru",messages:[{id:"m001",speaker:"client",timestamp:call?"2025-01-01T00:00:00Z":"00:00",text:"Вопрос"}]};});
 saveConversations(db,rows,dataset);
 const member=db.prepare("INSERT INTO official_group_members(group_id,conversation_id) VALUES (?,?)");
 const evaluation=db.prepare("INSERT INTO evaluations(conversation_id,checklist_version_id,status,created_at,model,data) VALUES (?,1,?,'now','gemini-3.5-flash','{}')");
 const criterion=db.prepare("INSERT INTO criterion_results(evaluation_id,criterion_id,criterion_hash,prompt_version,model,original,final) VALUES (?,?, 'hash','p1','gemini-3.5-flash',?,?)");
 for(let i=0;i<count;i++){
  member.run(dataset,rows[i].conversation_id);
  if(i===failureAt){evaluation.run(rows[i].conversation_id,"failed");continue;}
  const result=evaluation.run(rows[i].conversation_id,"done"), eid=Number(result.lastInsertRowid);
  const values=[{answer:"yes"},{answer:"yes"},{answer:"yes"},{scale_value:20},{answer:"yes"},{scale_value:10},{answer:"yes"},{answer:"no"}];
  for(let j=0;j<8;j++) criterion.run(eid,`c0${j+1}`,JSON.stringify({criterion_id:`c0${j+1}`,answer:null,scale_value:null,...values[j],explanation:"Проверено по транскрипту",evidence_ids:["m001"]}),JSON.stringify({criterion_id:`c0${j+1}`,answer:null,scale_value:null,...values[j],explanation:"Проверено по транскрипту",evidence_ids:["m001"]}));
 }
}
test("control group aliases, isolated invalid scores and selected model provenance remain exportable and truthful", () => {
 const db=openDatabase(":memory:");
 try {
  seedReadyGroup(db,"PROD",9);
  db.prepare("UPDATE conversations SET group_id='CONTROL-issued-key' WHERE group_id='PROD'").run();
  db.prepare("UPDATE official_group_members SET group_id='CONTROL-issued-key' WHERE group_id='PROD'").run();
  db.prepare("UPDATE evaluations SET model='ollama/qwen2.5' WHERE status='failed'").run();
  db.prepare("UPDATE evaluations SET data=? WHERE status='failed'").run(JSON.stringify({error:"Provider quota reached"}));
  const stored=db.prepare("SELECT evaluation_id,final FROM criterion_results WHERE criterion_id='c06' LIMIT 1").get();
  db.prepare("UPDATE criterion_results SET final=? WHERE evaluation_id=? AND criterion_id='c06'")
    .run(JSON.stringify({...JSON.parse(stored.final),scale_value:5}),stored.evaluation_id);
  const report=buildSubmission(db,{dataset:"PROD",group_id:"CONTROL-issued-key",checklist_version_id:1});
  assert.equal(report.ready,true);
  assert.equal(report.document.results.filter(r=>r.status==="error").length,2);
  assert.equal(report.document.results.find(r=>r.conversation_id==="PROD-9").error,"Provider quota reached");
  assert.equal(report.document.model.mode,"external_api");
  assert.equal(report.document.model.name,"gemini-3.5-flash");
 } finally {db.close();}
});
test("an all-error local run uses the actual Ollama configuration for both mode and model name", () => {
 const db=openDatabase(":memory:"); const previous={...process.env};
 try {
  seedReadyGroup(db,"PROD"); db.prepare("DELETE FROM criterion_results").run(); db.prepare("DELETE FROM evaluations").run();
  process.env.LLM_PROVIDER="ollama"; process.env.OLLAMA_MODEL="qwen2.5:14b";
  process.env.LLM_MODEL="ignored-wrong-variable";
  const report=buildSubmission(db,{dataset:"PROD",group_id:"PROD",checklist_version_id:1});
  assert.equal(report.ready,true); assert.deepEqual(report.document.model,{mode:"local",name:"ollama/qwen2.5:14b"});
  assert.equal(report.document.results.filter(r=>r.status==="error").length,10);
 } finally {process.env=previous;db.close();}
});
test("DEV exact 60 chat + 5 calls is ready; PROD download accepts one explicit error row",()=>{
 const db=openDatabase(":memory:");
 try {
  seedReadyGroup(db,"DEV");
  const dev=buildSubmission(db,{dataset:"DEV",group_id:"DEV",checklist_version_id:1});
  assert.equal(dev.ready,true); assert.deepEqual(dev.channel_counts,{chat:60,call:5}); assert.equal(dev.document.results.length,65);
  const prodDb=openDatabase(":memory:");
  try { seedReadyGroup(prodDb,"PROD",9); const prod=buildSubmission(prodDb,{dataset:"PROD",group_id:"PROD",checklist_version_id:1}); assert.equal(prod.ready,true); assert.equal(prod.document.results.filter(x=>x.status==="error").length,1); }
  finally {prodDb.close();}
 } finally {db.close();}
});
test("CLI exits without creating a results file when the group is incomplete",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cqa-export-"));
 try {
  const dbPath=join(dir,"empty.sqlite");
  const script=resolve("scripts/export-results.js");
  const result=spawnSync(process.execPath,[script,"--dataset=DEV"],{cwd:dir,env:{...process.env,CQA_DB_PATH:dbPath},encoding:"utf8"});
  assert.equal(result.status,1,result.stderr);
  assert.equal(existsSync(join(dir,"results","dev","results.json")),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("standalone validator rejects empty JSON and accepts a complete PROD set",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cqa-validate-"));
 try {
  const filename=join(dir,"results.json"), script=resolve("scripts/validate-results.js"), source=join(dir,"source.json");
  requireWrite(source,JSON.stringify(Array.from({length:10},(_,i)=>({conversation_id:`P-${i}`,channel:"agent chat",transcript:[{speaker:"client",text:"Context"}]}))));
  const empty=doc(); empty.results=[]; requireWrite(filename,JSON.stringify(empty));
  assert.equal(spawnSync(process.execPath,[script,filename,"--dataset=PROD",`--source=${source}`],{encoding:"utf8"}).status,1);
  const complete=doc(); complete.results=Array.from({length:10},(_,i)=>({...complete.results[0],conversation_id:`P-${i}`}));
  requireWrite(filename,JSON.stringify(complete));
  const ok=spawnSync(process.execPath,[script,filename,"--dataset=PROD",`--source=${source}`],{encoding:"utf8"});
  assert.equal(ok.status,0,ok.stderr); assert.match(ok.stdout,/Valid CQA Results/);
  complete.results[0].conversation_id="forged-id";
  requireWrite(filename,JSON.stringify(complete));
  assert.equal(spawnSync(process.execPath,[script,filename,"--dataset=PROD",`--source=${source}`],{encoding:"utf8"}).status,1);
  complete.results[0].conversation_id="P-0";complete.results[0].criteria[0].evidence_turns=[999];
  requireWrite(filename,JSON.stringify(complete));
  assert.equal(spawnSync(process.execPath,[script,filename,"--dataset=PROD",`--source=${source}`],{encoding:"utf8"}).status,1);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
function requireWrite(path,contents){ writeFileSync(path,contents); }
test("CLI exports a successful official dataset to the default results path",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cqa-export-ready-"));
 try {
  const dbPath=join(dir,"ready.sqlite"), db=openDatabase(dbPath);
  try {seedReadyGroup(db,"PROD");} finally {db.close();}
  const result=spawnSync(process.execPath,[resolve("scripts/export-results.js"),"--dataset=PROD"],{cwd:dir,env:{...process.env,CQA_DB_PATH:dbPath},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr); assert.equal(existsSync(join(dir,"results","prod","results.json")),true);
  const exported=JSON.parse(readFileSync(join(dir,"results","prod","results.json"),"utf8")); assert.equal(exported.results.length,10);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
