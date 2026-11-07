import test from "node:test";
import assert from "node:assert/strict";
import { submissionPage, submissionReport } from "./submission.js";
import { api } from "./api.js";

const options = { dataset: "DEV", group_id: "DEV/control&1", checklist_version_id: 7, source: "final", team_name: "Saw-cell" };

test("submission renders escaped API content and preserves evidence turn numbers", () => {
  const payload = '<img src=x onerror="alert(1)">';
  const id = "control/?" + payload;
  const html = submissionReport({
    ready: true, complete: true, expected_count: 1, actual_count: 1,
    source_ids: [id], warnings: [payload], errors: [payload],
    preview: { model: { mode: "external_api", name: payload }, results: [{
      conversation_id: id, status: "ok", score: { final_score: 0 },
      criteria: [{ criterion_id: "critical", value: false, rationale: payload, evidence_turns: [3, 12] }],
    }] },
  }, options);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(html, /#dialog\/control%2F%3F%3Cimg/);
  assert.match(html, /version=7&amp;turn=3/);
  assert.match(html, /version=7&amp;turn=12/);
  assert.match(html, /external_api/);
  assert.match(html, /Грубое нарушение · Нет/);
  assert.match(submissionPage({
    submissionOptions: { ...options, group_id: payload },
    versions: [{ id: 7, name: payload }],
  }), /value="&lt;img/);
});

test("full sets with error rows remain downloadable only when ready", () => {
  const report = {
    ready: true, complete: true, actual_count: 1, expected_count: 1,
    channel_counts: { chat: 1, call: 0 },
    preview: { results: [{ conversation_id: "abc", status: "error", error: "Оценка отсутствует" }] },
  };
  const html = submissionReport(report, options);
  assert.match(html, /Полный набор с ошибками оценки/);
  assert.match(html, /Оценка отсутствует/);
  assert.match(html, /data-action="download-submission" >|data-action="download-submission">/);
  assert.match(submissionReport({
    ...report, ready: false, errors: ["Source IDs do not match the organizer import manifest"],
  }, options), /data-action="download-submission" disabled/);
  assert.match(submissionReport({ ...report, ready: false, complete: false }, options), /Неполный набор/);
});

test("submission API sends organizer group separately and exposes 409 details", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const request = new URL(url, "http://localhost");
    assert.deepEqual(Object.fromEntries(request.searchParams), {
      ...options, checklist_version_id: "7",
    });
    if (request.pathname === "/api/submission/preview") return Response.json({ ready: false });
    assert.equal(request.pathname, "/api/submission/download");
    return Response.json({ error: "Submission is not ready", errors: ["Invalid manifest"] }, { status: 409 });
  });
  assert.deepEqual(await api.submissionPreview(options), { ready: false });
  await assert.rejects(api.submissionDownload(options), (error) =>
    error.status === 409 && error.details.errors[0] === "Invalid manifest");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ schema_version: "1.0" }));
  assert.deepEqual(JSON.parse(await (await api.submissionDownload(options)).text()), { schema_version: "1.0" });
});
