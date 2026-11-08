import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./fixtures.js";
const mock = JSON.parse(readFileSync(new URL("../shared/mocks/evaluation.json", import.meta.url)));

test("a jury-replaced criterion is persisted as a new version and actually evaluated using its new type and scale", () =>
  fixture(async (request) => {
    const first = (await request("/checklists/1")).body;
    const replacement = { ...first.criteria[0], id: "judge-custom", title: "Новый критерий жюри",
      description: "Оценить новое правило без встроенной трактовки c01.", type: "scale",
      scale: [{ value: 0, label: "Не выполнено" }, { value: 2, label: "Выполнено" }] };
    const saved = await request("/checklists", { ...first, criteria: [...first.criteria.slice(1), replacement] });
    assert.equal(saved.status, 201);
    assert.equal((await request("/checklists/1")).body.criteria[0].type, "binary");
    const queued = await request("/evaluate", { conversation_ids: "all", checklist_version_id: saved.body.id });
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await request(`/jobs/${queued.body.job_id}`)).body;
      if (["done", "error"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, "done", JSON.stringify(job));
    const result = (await request(`/evaluations?checklist_version_id=${saved.body.id}`)).body;
    assert.equal(result.criteria.some(c => c.criterion_id === "c01"), false);
    assert.equal(result.criteria.find(c => c.criterion_id === "judge-custom").final.scale_value, 2);
    assert.equal(result.total, 77.69);
  }, { jobs: { model: "test", evaluate: async (_conversation, criteria) => ({
    results: criteria.map(c => c.id === "judge-custom" ? { criterion_id: c.id, answer: null, scale_value: 2,
      explanation: "Тестовый ответ по новому критерию с опорой на m004.", evidence_ids: ["m004"], checked_range: null }
      : mock.criteria.find(r => r.criterion_id === c.id).original), calls: [],
  }) } }));

test("adding a ninth jury criterion keeps the eight originals and evaluates only the new rule", () => {
  const requested = [];
  return fixture(async request => {
    async function evaluateVersion(version) {
      const queued = await request('/evaluate', { conversation_ids: 'all', checklist_version_id: version });
      for (let i = 0; i < 100; i++) {
        const job = (await request(`/jobs/${queued.body.job_id}`)).body;
        if (job.status === 'done') return;
        assert.notEqual(job.status, 'error', JSON.stringify(job));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('Evaluation did not finish');
    }
    await evaluateVersion(1);
    const official = (await request('/checklists/1')).body;
    const added = { ...official.criteria[0], id: 'jury-followup', title: 'Срок следующего ответа',
      description: 'Оператор назвал срок следующего ответа после передачи обращения.' };
    const saved = await request('/checklists', { ...official, criteria: [...official.criteria, added] });
    assert.equal(saved.status, 201);
    await evaluateVersion(saved.body.id);
    assert.deepEqual(requested.at(-1), ['jury-followup']);
    const result = (await request(`/evaluations?checklist_version_id=${saved.body.id}`)).body;
    assert.equal(result.criteria.length, 9);
    assert.equal(result.criteria.find(c => c.criterion_id === 'jury-followup').final.answer, 'yes');
    assert.equal((await request('/checklists/1')).body.criteria.length, 8);
  }, { jobs: { model: 'test', evaluate: async (_conversation, criteria) => {
    requested.push(criteria.map(c => c.id));
    return { results: criteria.map(c => c.id === 'jury-followup'
      ? { criterion_id: c.id, answer: 'yes', scale_value: null,
        explanation: 'Тестовый ответ по новому правилу.', evidence_ids: ['m004'], checked_range: null }
      : mock.criteria.find(r => r.criterion_id === c.id).original), calls: [] };
  } } });
});
