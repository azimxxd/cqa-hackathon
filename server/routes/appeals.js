import { Router } from 'express';
import { getChecklist, now, transaction } from '../db.js';
import { getEvaluation } from '../evaluations.js';
import { getConversation } from '../import.js';
import { validateResult } from '../scoring.js';
import { fail, positiveId } from '../http.js';
const textRequired=(value,name)=>{if(typeof value!=='string'||!value.trim())throw fail(400,`${name} is required`);return value;};
export function appealRoutes(db){
 const router=Router();
 router.post('/appeals',(req,res)=>{
  const evaluationId=positiveId(req.body.evaluation_id,'evaluation_id');
  const evaluation=getEvaluation(db,evaluationId);
  if(!evaluation)throw fail(404,'Evaluation not found');
  if(evaluation.status!=='done')throw fail(409,'Evaluation is not complete');
  const criterionId=req.body.criterion_id;
  if(!evaluation.criteria.some(c=>c.criterion_id===criterionId))throw fail(400,'Unknown criterion_id');
  const comment=textRequired(req.body.comment,'comment');
  if(db.prepare("SELECT 1 FROM appeals WHERE evaluation_id=? AND criterion_id=? AND status='open'").get(evaluationId,criterionId))throw fail(409,'An appeal is already open');
  const id=Number(db.prepare('INSERT INTO appeals(evaluation_id,criterion_id,comment,created_at) VALUES (?,?,?,?)').run(evaluationId,criterionId,comment,now()).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM appeals WHERE id=?').get(id));
 });
 router.get('/appeals',(req,res)=>{
  if(req.query.status&&!['open','decided'].includes(req.query.status))throw fail(400,'Invalid appeal status');
  const rows=db.prepare(`SELECT * FROM appeals ${req.query.status?'WHERE status=?':''} ORDER BY id`).all(...(req.query.status?[req.query.status]:[]));
  res.json(rows.map(appeal=>{
   const evaluation=getEvaluation(db,appeal.evaluation_id);
   const result=evaluation.criteria.find(c=>c.criterion_id===appeal.criterion_id).final;
   const messages=getConversation(db,evaluation.conversation_id).messages;
   const anchors=new Set([...result.evidence_ids,...(result.checked_range?[result.checked_range.from,result.checked_range.to]:[])]);
   // Union of windows, so distant evidence does not return an entire transcript.
   const indices=new Set();messages.forEach((m,i)=>{if(anchors.has(m.id))for(let n=Math.max(0,i-2);n<=Math.min(messages.length-1,i+2);n++)indices.add(n);});
   return {...appeal,messages:messages.filter((_m,i)=>indices.has(i))};
  }));
 });
 router.post('/appeals/:id/decision',(req,res)=>{
  const id=positiveId(req.params.id);const body=req.body;
  if(!['confirm','change'].includes(body.action))throw fail(400,'Invalid decision action');
  textRequired(body.reason,'reason');
  const evaluation=transaction(db,()=>{
   const appeal=db.prepare('SELECT * FROM appeals WHERE id=?').get(id);
   if(!appeal)throw fail(404,'Appeal not found');
   if(appeal.status!=='open')throw fail(409,'Appeal is already decided');
   const evaluation=getEvaluation(db,appeal.evaluation_id);
   const row=evaluation.criteria.find(c=>c.criterion_id===appeal.criterion_id);
   let result=row.final;
   if(body.action==='change'){
    const criterion=getChecklist(db,evaluation.checklist_version_id).criteria.find(c=>c.id===appeal.criterion_id);
    result={...row.final,answer:body.new_answer??null,scale_value:body.new_scale_value??null};
    // A reviewer may switch yes to no; retain the evidence window or derive it from cited messages.
    if(result.answer==='no'&&!result.checked_range){
     const messages=getConversation(db,evaluation.conversation_id).messages;
     const evidence=messages.filter(m=>result.evidence_ids.includes(m.id));
     if(evidence.length)result.checked_range={from:evidence[0].id,to:evidence.at(-1).id};
    }
    try{validateResult(criterion,result,getConversation(db,evaluation.conversation_id));}catch(error){throw fail(400,error.message);}
    db.prepare('UPDATE criterion_results SET final=? WHERE evaluation_id=? AND criterion_id=?').run(JSON.stringify(result),appeal.evaluation_id,appeal.criterion_id);
   }
   db.prepare('INSERT INTO review_decisions(appeal_id,action,new_answer,new_scale_value,reason,decided_at) VALUES (?,?,?,?,?,?)')
    .run(id,body.action,body.action==='change'?result.answer:null,body.action==='change'?result.scale_value:null,body.reason,now());
   db.prepare("UPDATE appeals SET status='decided' WHERE id=?").run(id);
   return getEvaluation(db,appeal.evaluation_id);
  });
  res.json(evaluation);
 });
 return router;
}
