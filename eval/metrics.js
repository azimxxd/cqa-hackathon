import {totalScore,grossError,labelOf} from './score.js';
export function buildMetrics(rows,labels,criteria) {
  const perCrit=Object.fromEntries(criteria.map(c=>[c.id,{agree:0,n:0,misses:[]}]));
  let absErr=0,nTotal=0,grossAgree=0,nGross=0;
  const details=[];
  for(const row of [...rows].sort((a,b)=>a.id.localeCompare(b.id))) {
    const gt=labels.get(row.id);
    for(const c of criteria) {
      const g=gt.find(x=>x.criterion_id===c.id);
      if(!g) continue;
      const r=row.results?.find(x=>x.criterion_id===c.id);
      const pred=row.error ? undefined : labelOf(r,c), exp=labelOf(g,c);
      perCrit[c.id].n++;
      if(!row.error && pred===exp) perCrit[c.id].agree++;
      else perCrit[c.id].misses.push({id:row.id,expected:exp,got:pred ?? null,explanation:row.error || r?.explanation,note:g.note});
    }
    nGross++;
    if(row.error) {details.push({id:row.id,error:row.error});continue;}
    const tp=totalScore(row.results,criteria),tg=totalScore(gt,criteria);
    if(tp!=null && tg!=null) {absErr+=Math.abs(tp-tg);nTotal++;}
    if(grossError(row.results,criteria)===grossError(gt,criteria)) grossAgree++;
    details.push({id:row.id,total_pred:tp,total_gt:tg});
  }
  const calls=rows.flatMap(r=>r.calls || []);
  const sum=(list,key)=>list.reduce((s,c)=>s+(c[key] || 0),0);
  const full=rows.filter(r=>r.calls?.length && criteria.every(c=>r.evaluated_criteria?.includes(c.id)));
  const fullCost=full.reduce((s,r)=>s+sum(r.calls,'cost_usd'),0);
  return {
    conversations:rows.length,
    errors:rows.filter(r=>r.error).length,
    cached_answers:rows.reduce((s,r)=>s+(r.cached_count || 0),0),
    evaluations_done:rows.filter(r=>!r.error).length,
    per_criterion:Object.fromEntries(Object.entries(perCrit).map(([k,v])=>[k,{accuracy:v.n ? +(v.agree/v.n).toFixed(3) : null,n:v.n}])),
    overall_criterion_accuracy:+(Object.values(perCrit).reduce((s,v)=>s+v.agree,0)/Math.max(1,Object.values(perCrit).reduce((s,v)=>s+v.n,0))).toFixed(3),
    total_mae:nTotal ? +(absErr/nTotal).toFixed(2) : null,
    total_mae_evaluations:nTotal,
    gross_error_accuracy:nGross ? +(grossAgree/nGross).toFixed(3) : null,
    cost:{
      calls:calls.length,input_tokens:sum(calls,'input_tokens'),output_tokens:sum(calls,'output_tokens'),cost_usd:+sum(calls,'cost_usd').toFixed(6),
      evaluations_with_calls:rows.filter(r=>r.calls?.length).length,
      full_evaluations_with_calls:full.length,
      avg_cost_per_eval_usd:full.length ? +(fullCost/full.length).toFixed(6) : 0,
      avg_latency_ms:calls.length ? Math.round(sum(calls,'latency_ms')/calls.length) : null,
      note:'Full evaluations only in average; failed attempts included. Cached/partial evaluations excluded.',
    },
    totals:details,misses:Object.fromEntries(Object.entries(perCrit).map(([k,v])=>[k,v.misses])),
  };
}
