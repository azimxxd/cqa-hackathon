import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, getChecklist } from './db.js';
import { saveConversations, getConversation } from './import.js';
import { createJobService, fakeEvaluate } from './jobs.js';
import { evaluationConfig, configHash } from '../ai/config.js';
import { evaluationIsCurrent, messageHash } from './evaluation-freshness.js';
const source = JSON.parse(readFileSync(new URL('../shared/mocks/conversation.json', import.meta.url)));
async function finish(service, id) {
  for (let i=0;i<100;i++) { const job=service.get(id); if(['done','error'].includes(job.status)) return job; await new Promise(r=>setTimeout(r,5)); }
  throw Error('timeout');
}
test('server cache separates votes, temperature, thinking and source text; changed settings reject restored jobs', async()=>{
  const db=openDatabase(':memory:'); saveConversations(db,[source],'DEV'); let calls=0; let lastJob;
  const run=async(config,expected)=>{
    const service=createJobService(db,{model:'audit-model',config,evaluate:async(c,cs,meta,opts)=>{
      calls++; assert.equal(opts.config.samples,config.samples); return fakeEvaluate(c,cs);
    }});
    const {job_id}=await service.submit({checklist_version_id:1,conversation_ids:[source.conversation_id]});
    assert.equal((await finish(service,job_id)).status,'done');assert.equal(calls,expected);
    await service.close();lastJob=job_id;
  };
  await run({samples:1},1); await run({samples:3},2); await run({samples:3},2);
  await run({samples:3,sampleTemperature:0.4},3);
  await run({samples:3,ollamaThink:true},4);
  db.prepare('UPDATE messages SET text=text||? WHERE conversation_id=? AND idx=0').run(' changed',source.conversation_id);
  await run({samples:3,ollamaThink:true},5);
  const job=JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(lastJob).data);
  job.items[0].status='queued';job.status='queued';job.done=0;
  db.prepare('UPDATE evaluations SET status=? WHERE id=?').run('queued',job.items[0].evaluation_id);
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job),lastJob);
  const changed=createJobService(db,{model:'audit-model',config:{samples:5},evaluate:()=>{throw Error('must not invoke')}});
  assert.equal((await finish(changed,lastJob)).status,'error');assert.equal(calls,5);
  await changed.close();
  job.items[0].status='queued'; job.status='queued';job.done=0;job.errors=[];
  db.prepare('UPDATE evaluations SET status=? WHERE id=?').run('queued',job.items[0].evaluation_id);
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job),lastJob);
  db.prepare('UPDATE messages SET text=text||? WHERE conversation_id=? AND idx=0').run(' newer',source.conversation_id);
  const staleText=createJobService(db,{model:'audit-model',config:{samples:3,ollamaThink:true},evaluate:()=>{throw Error('must not invoke')}});
  const rejected=await finish(staleText,lastJob);assert.equal(rejected.status,'error');assert.match(rejected.errors[0].error,/Исходный текст изменился/);
  await staleText.close();db.close();
});
test('submission freshness rejects old model, prompt, settings, source and unknown legacy metadata',()=>{
  const db=openDatabase(':memory:');saveConversations(db,[source],'DEV');
  const context={model:'audit-model',promptVersion:'v16',config:evaluationConfig({samples:3}),checklist:getChecklist(db,1),conversation:getConversation(db,source.conversation_id)};
  const data={config_id:configHash(context.config),prompt_key:'v16|frt=180',transcript_source:'original',transcript_hash:messageHash(context.conversation.messages)};
  const row={status:'done',model:'audit-model',data:JSON.stringify(data)};
  assert.equal(evaluationIsCurrent(row,context),true);
  for(const change of [{config_id:'old'},{prompt_key:'v15|frt=180'},{transcript_hash:'old'},{transcript_source:'gemini'}])
    assert.equal(evaluationIsCurrent({...row,data:JSON.stringify({...data,...change})},context),false);
  for(const change of [{status:'error'},{model:'other'},{data:'{}'},{data:'not-json'}])assert.equal(evaluationIsCurrent({...row,...change},context),false);
  db.close();
});
