import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./fixtures.js";
const mock = JSON.parse(
  readFileSync(new URL("../shared/mocks/evaluation.json", import.meta.url)),
);
async function evaluate(request) {
  const {
    body: { job_id },
  } = await request("/evaluate", {
    conversation_ids: "all",
    checklist_version_id: 1,
  });
  for (let i = 0; i < 100; i++) {
    const job = (await request(`/jobs/${job_id}`)).body;
    if (job.status === "done") return;
    assert.notEqual(job.status, "error");
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Timeout");
}
test("appeal cycle preserves original and atomically changes final; invalid decisions roll back", () =>
  fixture(
    async (request, db) => {
      await evaluate(request);
      const e = (
        await request(
          "/evaluations?conversation_id=mock-ru-001&checklist_version_id=1",
        )
      ).body;
      assert.equal(e.total, 77.69);
      const appeal = await request("/appeals", {
        evaluation_id: e.id,
        criterion_id: "c07",
        comment: "review",
      });
      assert.equal(appeal.status, 201);
      assert.equal(
        (
          await request("/appeals", {
            evaluation_id: e.id,
            criterion_id: "c07",
            comment: "duplicate",
          })
        ).status,
        409,
      );
      const list = (await request("/appeals?status=open")).body;
      assert.ok(list[0].messages.some((m) => m.id === "m009"));
      const decision = await request(`/appeals/${appeal.body.id}/decision`, {
        action: "change",
        new_answer: "yes",
        reason: "Verified greeting",
      });
      assert.equal(decision.status, 200);
      assert.equal(decision.body.total, 85.38);
      assert.equal(decision.body.original_total, 77.69);
      assert.equal(decision.body.criteria[6].appealed, true);
      assert.equal((await request("/appeals?status=open")).body.length, 0);
      assert.equal(
        (
          await request(`/appeals/${appeal.body.id}/decision`, {
            action: "confirm",
            reason: "again",
          })
        ).status,
        409,
      );
      const second = (
        await request("/appeals", {
          evaluation_id: e.id,
          criterion_id: "c01",
          comment: "review",
        })
      ).body;
      assert.equal(
        (
          await request(`/appeals/${second.id}/decision`, {
            action: "change",
            new_answer: "na",
            reason: "not allowed",
          })
        ).status,
        400,
      );
      assert.equal((await request("/appeals?status=open")).body.length, 1);
      const confirmed = await request(`/appeals/${second.id}/decision`, {
        action: "confirm",
        reason: "Correct",
      });
      assert.equal(confirmed.body.total, 85.38);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM review_decisions").get().n,
        2,
      );
    },
    {
      jobs: {
        model: "test",
        evaluate: async (_c, criteria) => ({
          results: criteria.map(
            (c) => mock.criteria.find((r) => r.criterion_id === c.id).original,
          ),
          calls: [],
        }),
      },
    },
  ));

test('reviewer supplies evidence and checked range for a no answer with no previous evidence',()=>fixture(async(request,db)=>{
 await evaluate(request);
 const before=(await request('/evaluations')).body;
 const appeal=(await request('/appeals',{evaluation_id:before.id,criterion_id:'c01',comment:'missed action'})).body;
 const path=`/appeals/${appeal.id}/decision`;
 for(const patch of [{new_evidence_ids:['missing']},{new_checked_range:{from:'m009',to:'m001'}},{new_evidence_ids:'m004'}]) {
  assert.equal((await request(path,{action:'change',new_answer:'no',reason:'review',new_checked_range:{from:'m004',to:'m004'},...patch})).status,400);
 }
 const result=await request(path,{action:'change',new_answer:'no',reason:'review',new_evidence_ids:['m004'],new_checked_range:{from:'m004',to:'m004'}});
 assert.equal(result.status,200);assert.notEqual(result.body.total,before.total);
 assert.deepEqual(result.body.criteria[0].original,before.criteria[0].original);
 assert.deepEqual(result.body.criteria[0].final.checked_range,{from:'m004',to:'m004'});
 assert.deepEqual(result.body.criteria[0].final.evidence_ids,['m004']);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM review_decisions').get().n,1);
},{jobs:{model:'test',evaluate:async(_c,criteria)=>({results:criteria.map(c=>({...mock.criteria.find(r=>r.criterion_id===c.id).original,...(c.id==='c01'?{evidence_ids:[],checked_range:null}:{})})),calls:[]})}}));
