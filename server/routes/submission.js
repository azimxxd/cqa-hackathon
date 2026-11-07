import { Router } from "express";
import { buildSubmission } from "../../shared/submission.js";
import { fail } from "../http.js";
export function submissionRoutes(db) {
  const router=Router();
  const get=(req)=>{
    const q=req.query;
    if (!q.team_name || !q.dataset || !q.group_id || !q.checklist_version_id || !q.source) throw fail(400,"team_name, dataset, group_id, checklist_version_id and source are required");
    if (!/^\d+$/.test(String(q.checklist_version_id))) throw fail(400,"Invalid checklist_version_id");
    try { return buildSubmission(db,{team_name:q.team_name,dataset:q.dataset,group_id:q.group_id,checklist_version_id:q.checklist_version_id,source:q.source}); }
    catch(e) { if(e.status) throw e; throw fail(500,"Submission preview failed"); }
  };
  router.get("/submission/preview",(req,res)=>{const report=get(req); const {document,...summary}=report; res.json({...summary,preview:document});});
  router.get("/submission/download",(req,res)=>{const report=get(req); if(!report.ready) return res.status(409).json({error:"Submission is not ready",...report,document:undefined}); res.type("application/json").set("Content-Disposition",`attachment; filename="${req.query.dataset.toLowerCase()}-results.json"`).send(JSON.stringify(report.document,null,2));});
  return router;
}
