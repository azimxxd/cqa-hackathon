import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openDatabase, getChecklist, saveChecklist } from '../server/db.js';

test('control command reevaluates changed settings, exports provenance and protects existing output on stale --none', t=>{
 const dir=mkdtempSync(join(tmpdir(),'cqa-control-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const root=fileURLToPath(new URL('../',import.meta.url));
 const original=JSON.parse(readFileSync(join(root,'shared/mocks/conversation.json')));
 const mock=JSON.parse(readFileSync(join(root,'shared/mocks/evaluation.json')));
 const records=Array.from({length:10},(_,i)=>({...original,conversation_id:`control-${i}`}));
 const loader=join(dir,'provider.mjs');
 writeFileSync(loader,`const records=${JSON.stringify(records)};const mock=${JSON.stringify(mock)};
 globalThis.fetch=async(url,init)=>{
 if(String(url).includes('organizer.example')) return Response.json({isSuccess:true,data:{records}});
 const body=JSON.parse(init.body);const ids=body.generationConfig.responseSchema.properties.results.items.properties.criterion_id.enum;
 return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({results:ids.map(id=>mock.criteria.find(c=>c.criterion_id===id).original)})}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}});
 };`);
 const out=join(dir,'results.json');
 const run=(samples,extra=[])=>spawnSync(process.execPath,['--import',loader,join(root,'scripts/prod-run.js'),'--group_id=CONTROL','--output='+out,...extra],{
  cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,CQA_DB_PATH:join(dir,'cqa.db'),ORG_API_URL:'https://organizer.example/api',LLM_PROVIDER:'gemini',GEMINI_API_KEY:'stub',GEMINI_API_KEYS:'',GEMINI_MODEL:'gemini-3.1-flash-lite',LLM_SAMPLES:String(samples),CQA_FAKE_LLM:'0'},
 });
 const first=run(1);assert.equal(first.status,0,first.stderr+first.stdout);
 const p1=JSON.parse(readFileSync(out+'.provenance.json'));assert.equal(p1.evaluations.length,10);
 const stable=readFileSync(out,'utf8');
 const stale=run(3,['--reevaluate=none']);assert.equal(stale.status,1);assert.match(stale.stderr,/stale evaluations/);assert.equal(readFileSync(out,'utf8'),stable);
 const refreshed=run(3);assert.equal(refreshed.status,0,refreshed.stderr+refreshed.stdout);
 const p3=JSON.parse(readFileSync(out+'.provenance.json'));assert.notEqual(p1.config_id,p3.config_id);
 assert.ok(p3.evaluations.every((e,i)=>e.evaluation_id>p1.evaluations[i].evaluation_id));
 assert.equal(p3.result_sha256,createHash('sha256').update(readFileSync(out)).digest('hex'));

 // An edited latest checklist must not waste model calls or poison the official run.
 const db=openDatabase(join(dir,'cqa.db'));
 const official=getChecklist(db,1);
 const custom=saveChecklist(db,{...official,criteria:[...official.criteria,
  {...official.criteria[0],id:'jury-added',title:'Правило, добавленное жюри'}]});
 db.close();
 const afterJury=run(3);assert.equal(afterJury.status,0,afterJury.stderr+afterJury.stdout);
 assert.equal(JSON.parse(readFileSync(out+'.provenance.json')).checklist_version_id,1);
 const rejected=run(3,['--checklist_version_id='+custom.id]);
 assert.equal(rejected.status,1);assert.match(rejected.stderr,/not compatible/);
 assert.doesNotMatch(rejected.stdout,/\[import\]/);

 // Entirely new IDs and changed text enter through a supplied JSON file, not the API.
 const fresh=records.map((r,i)=>({...r,conversation_id:`unseen-${i}`,
  messages:r.messages.map(m=>({...m,text:`Новый контрольный текст ${i}. ${m.text}`}))}));
 const input=join(dir,'incoming.json');writeFileSync(input,JSON.stringify(fresh));
 const offline=run(3,['--group_id=FRESH','--input='+input]);
 assert.equal(offline.status,0,offline.stderr+offline.stdout);
 assert.deepEqual(JSON.parse(readFileSync(out)).results.map(r=>r.conversation_id),fresh.map(r=>r.conversation_id));
 assert.equal(JSON.parse(readFileSync(out+'.provenance.json')).input_sha256,
  createHash('sha256').update(JSON.stringify(fresh)).digest('hex'));
});
