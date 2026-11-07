import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './test-helpers.js';
const mock=JSON.parse(readFileSync(new URL('../shared/mocks/evaluation.json',import.meta.url)));
async function evaluate(request){
 const {body:{job_id}}=await request('/evaluate',{conversation_ids:'all',checklist_version_id:1});
 for(let i=0;i<100;i++){const job=(await request(`/jobs/${job_id}`)).body;if(job.status==='done')return;assert.notEqual(job.status,'error');await new Promise(r=>setTimeout(r,5));}throw Error('Timeout');
}
test('appeal cycle preserves original and atomically changes final; invalid decisions roll back',()=>fixture(async(request,db)=>{
 await evaluate(request);
 const e=(await request('/evaluations?conversation_id=mock-ru-001&checklist_version_id=1')).body;
 assert.equal(e.total,77.69);
 const appeal=await request('/appeals',{evaluation_id:e.id,criterion_id:'c07',comment:'review'});
 assert.equal(appeal.status,201);
 assert.equal((await request('/appeals',{evaluation_id:e.id,criterion_id:'c07',comment:'duplicate'})).status,409);
 const list=(await request('/appeals?status=open')).body;
 assert.ok(list[0].messages.some(m=>m.id==='m009'));
 const decision=await request(`/appeals/${appeal.body.id}/decision`,{action:'change',new_answer:'yes',reason:'Verified greeting'});
 assert.equal(decision.status,200);assert.equal(decision.body.total,85.38);assert.equal(decision.body.original_total,77.69);
 assert.equal(decision.body.criteria[6].appealed,true);
 assert.equal((await request('/appeals?status=open')).body.length,0);
 assert.equal((await request(`/appeals/${appeal.body.id}/decision`,{action:'confirm',reason:'again'})).status,409);
 const second=(await request('/appeals',{evaluation_id:e.id,criterion_id:'c01',comment:'review'})).body;
 assert.equal((await request(`/appeals/${second.id}/decision`,{action:'change',new_answer:'na',reason:'not allowed'})).status,400);
 assert.equal((await request('/appeals?status=open')).body.length,1);
 const confirmed=await request(`/appeals/${second.id}/decision`,{action:'confirm',reason:'Correct'});
 assert.equal(confirmed.body.total,85.38);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM review_decisions').get().n,2);
},{jobs:{model:'test',evaluate:async(_c,criteria)=>({results:criteria.map(c=>mock.criteria.find(r=>r.criterion_id===c.id).original),calls:[]})}}));
