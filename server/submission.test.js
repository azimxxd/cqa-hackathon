import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures.js";
import { saveConversations } from "./import.js";

test("submission preview reports incomplete groups; download blocks and bad parameters return 400", () =>
  fixture(async (request) => {
    const query = "team_name=Saw-cell&dataset=DEV&group_id=DEV&checklist_version_id=1&source=final";
    const preview = await request(`/submission/preview?${query}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ready, false);
    assert.equal(preview.body.expected_count, 65);
    assert.equal(preview.body.actual_count, 1);
    assert.equal(preview.body.preview.results.length, 1);
    assert.equal(preview.body.preview.results[0].status, "error");

    const download = await request(`/submission/download?${query}`);
    assert.equal(download.status, 409);
    assert.equal(download.body.error, "Submission is not ready");
    assert.equal((await request(`/submission/preview?${query.replace("source=final", "source=other")}`)).status, 400);
    assert.equal((await request("/submission/preview")).status, 400);
  }));

test("complete PROD download returns official JSON while preserving a failed row", () =>
  fixture(async (request, db) => {
    const conversations=Array.from({length:10},(_,i)=>({conversation_id:`P-${i}`,channel:"agent chat",language:"ru",messages:[{speaker:"client",timestamp:"00:00",text:"Вопрос"}]}));
    saveConversations(db,conversations,"PROD");
    const member=db.prepare("INSERT INTO official_group_members(group_id,conversation_id) VALUES ('PROD',?)");
    const evalInsert=db.prepare("INSERT INTO evaluations(conversation_id,checklist_version_id,status,created_at,model,data) VALUES (?,1,?,'now','gemini-3.5-flash','{}')");
    const criterion=db.prepare("INSERT INTO criterion_results(evaluation_id,criterion_id,criterion_hash,prompt_version,model,original,final) VALUES (?,?, 'h','p1','gemini-3.5-flash',?,?)");
    conversations.forEach((c,i)=>{member.run(c.conversation_id);const res=evalInsert.run(c.conversation_id,i===9?"failed":"done");if(i===9)return;const id=Number(res.lastInsertRowid);const vals=[{answer:"yes"},{answer:"yes"},{answer:"yes"},{scale_value:20},{answer:"yes"},{scale_value:10},{answer:"yes"},{answer:"no"}];vals.forEach((v,j)=>{const obj={criterion_id:`c0${j+1}`,answer:null,scale_value:null,...v,explanation:"проверено",evidence_ids:["m001"]};criterion.run(id,`c0${j+1}`,JSON.stringify(obj),JSON.stringify(obj));});});
    const query="team_name=Saw-cell&dataset=PROD&group_id=PROD&checklist_version_id=1&source=final";
    const response=await request(`/submission/download?${query}`);
    const result=await request(`/submission/preview?${query}`);
    assert.equal(result.status,200); assert.equal(result.body.ready,true);
    assert.equal(result.body.preview.results.filter(x=>x.status==="error").length,1);
    assert.equal(response.status,200); assert.equal(response.body.results.length,10);
    assert.equal(response.body.results[9].status,"error");
  }));
