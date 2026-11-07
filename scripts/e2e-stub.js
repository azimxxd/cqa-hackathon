// End-to-end API exercise. Only this process's loopback server may use real fetch.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/db.js';
import {createApp} from '../server/app.js';
import {getEvaluation} from '../server/evaluations.js';
const load=name=>JSON.parse(readFileSync(new URL(`../shared/mocks/${name}.json`,import.meta.url)));
const conversation=load('conversation'),mock=load('evaluation');
const dir=mkdtempSync(join(tmpdir(),'cqa-e2e-')),file=join(dir,'stub.db');
const oldFetch=globalThis.fetch,previousEnv={...process.env};
const ids=['stub-a','stub-b'],requests=[];
let db,app,server,base;
Object.assign(process.env,{GEMINI_API_KEY:'stub',GEMINI_MODEL:'gemini-2.5-flash',LLM_PROVIDER:'gemini',CQA_FAKE_LLM:'0',ORG_API_URL:'https://organizer.stub.test/records',GEMINI_MAX_ATTEMPTS:'2',GEMINI_MAX_BACKOFF_MS:'0'});
delete process.env.AI_CACHE_DIR;
globalThis.fetch=async(url,init)=>{
 const address=String(url);
 if(base && address.startsWith(`${base}/`)) return oldFetch(url,init);
 if(address.startsWith('https://organizer.stub.test/records?')) {
  assert.equal(new URL(url).searchParams.get('group_id'),'STUB');
  return Response.json({isSuccess:true,data:{records:ids.map(conversation_id=>({...conversation,conversation_id,messages:undefined,transcript:conversation.messages}))}});
 }
 if(address.startsWith('https://generativelanguage.googleapis.com/')) {
  const body=JSON.parse(init.body);
  assert.equal(init.headers['x-goog-api-key'],'stub');
  const criteria=body.generationConfig.responseSchema.properties.results.items.properties.criterion_id.enum;
  requests.push(criteria);
  return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({results:criteria.map(id=>{
   const original=mock.criteria.find(c=>c.criterion_id===id).original;
   const {checked_range,...r}=original;
   return {...r,checked_from:checked_range?.from ?? null,checked_to:checked_range?.to ?? null};
  })})}]}}],usageMetadata:{promptTokenCount:1000,candidatesTokenCount:200,thoughtsTokenCount:50}});
 }
 throw Error(`Unstubbed request blocked: ${new URL(address).origin}`);
};
async function start() {
 db=openDatabase(file);app=createApp(db,{jobs:{retries:0,concurrency:2}});server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
}
async function stop() {
 if(!app) return;
 await app.locals.jobs.close();await new Promise(r=>server.close(r));db.close();app=null;server=null;db=null;
}
async function request(path,body) {
 const response=await fetch(`${base}/api${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
async function evaluate(version) {
 const {job_id}=await request('/evaluate',{conversation_ids:'all',checklist_version_id:version});
 for(let i=0;i<500;i++) {
  const job=await request(`/jobs/${job_id}`);
  if(job.status==='done') {assert.equal(job.done,2);return job_id;}
  assert.notEqual(job.status,'error',JSON.stringify(job.errors));await new Promise(r=>setTimeout(r,2));
 }
 throw Error('E2E job timeout');
}
try {
 await start();
 assert.deepEqual(await request('/import',{group_id:'STUB'}),{imported:2});
 const jobId=await evaluate(1);
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.length===8));
 const before=await request('/evaluations?conversation_id=stub-a&version=1');assert.equal(before.total,77.69);
 const appeal=await request('/appeals',{evaluation_id:before.id,criterion_id:'c07',comment:'Review closing'});
 const after=await request(`/appeals/${appeal.id}/decision`,{action:'change',new_answer:'yes',new_evidence_ids:['m007'],new_checked_range:{from:'m007',to:'m009'},reason:'Reviewer confirmed closing'});
 assert.equal(after.total,85.38);assert.equal(after.original_total,77.69);assert.deepEqual(after.criteria.map(c=>c.original),before.criteria.map(c=>c.original));
 const first=await request('/checklists/1');
 const weighted=structuredClone(first);weighted.criteria[0].weight=20;
 const v2=await request('/checklists',weighted);await evaluate(v2.id);assert.equal(requests.length,2);
 const rewritten=structuredClone(v2);rewritten.criteria[3].description+=' Synthetic edited criterion.';
 const v3=await request('/checklists',rewritten);await evaluate(v3.id);
 assert.deepEqual(requests.slice(2),[['c04'],['c04']]);
 const v4=await request('/checklists',{...v3,first_reaction_threshold_sec:30});await evaluate(v4.id);
 assert.deepEqual(requests.slice(4),[['c06'],['c06']]);
 const lastBefore=await request(`/evaluations?conversation_id=stub-a&version=${v4.id}`);
 const statsBefore=await request('/stats');assert.equal(statsBefore.calls,6);assert.equal(statsBefore.evaluations_done,8);assert.equal(statsBefore.evaluations_with_calls,6);
 await stop();await start();
 assert.deepEqual(await request(`/evaluations?conversation_id=stub-a&version=${v4.id}`),lastBefore);
 assert.equal((await request(`/jobs/${jobId}`)).status,'done');
 assert.equal(getEvaluation(db,before.id).total,85.38);assert.equal(getEvaluation(db,before.id).original_total,77.69);
 assert.deepEqual(await request('/stats'),statsBefore);
 assert.equal((await request('/appeals?status=decided')).length,1);
 assert.equal((await request('/conversations')).length,2);
 console.log('E2E stub OK: records import → evaluate → appeal/change → weights/cache → c04 only → c06 only → restart; 6 stub Gemini calls, no external requests.');
}finally {
 await stop();globalThis.fetch=oldFetch;
 for(const key of Object.keys(process.env)) if(!(key in previousEnv)) delete process.env[key];Object.assign(process.env,previousEnv);
 rmSync(dir,{recursive:true,force:true});
}
