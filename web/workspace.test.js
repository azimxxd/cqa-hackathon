import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "./api.js";
import { evaluationTextSource, scorecard } from "./views.js";
import { feedRows, workspacePage, transcriptControls, transcriptMessages } from "./workspace.js";

const original = {
  conversation_id: "call/?1",
  channel: "voice call",
  language: "ru",
  messages: [
    { id: 'first"<', idx: 0, speaker: "operator", text: "Исходный текст", offset_sec: 64, timestamp: "original" },
    { id: "system", idx: 1, speaker: "system", text: "Служебное сообщение", offset_sec: 65 },
  ],
};
const checklist = {
  id: 2, name: "Чек-лист", sections: [{ id: "main", title: "Качество" }],
  criteria: [{ id: "greeting", section: "main", title: "Приветствие", type: "binary" }],
};
const result = { answer: "no", evidence_ids: [original.messages[0].id], explanation: "<script>bad()</script>" };
const evaluation = {
  id: 7, status: "done", total: 42, source: "algos", model: "prior-model",
  criteria: [{ criterion_id: "greeting", original: result, final: result }],
};
const state = {
  conversations: [{ ...original, total: 42 }, { conversation_id: "another", channel: "agent chat" }],
  detail: { conversation: original, evaluation, checklist },
  version: 2, versions: [checklist], checklist, search: "", filter: "all", selected: original.conversation_id,
  appeals: [{ id: 9, evaluation_id: 7, criterion_id: "greeting", conversation_id: original.conversation_id, status: "open" }],
  ai: { configured: true, transcription_configured: true, transcription_model: "gemini-model" },
};
test("workspace pairs feed selection with the real call player, citation, and reviewer action", () => {
  const html = workspacePage({ ...state, role: "reviewer" });
  assert.match(html, /href="#dialog\/call%2F%3F1"[^>]+aria-current="true"/);
  assert.match(html, /<audio[^>]+src="\/api\/audio\/call%2F%3F1"/);
  assert.match(html, /data-message="first&quot;&lt;"/);
  assert.match(html, /data-evidence="first&quot;&lt;"/);
  assert.match(html, /data-review="9"/);
  assert.doesNotMatch(html, /data-appeal="greeting"|<script>/);
  assert.match(html, /Токены и стоимость API не измерялись/);
  const drawer = workspacePage({ ...state, drawer: true });
  assert.match(drawer, /id="checklist-form"/);
  assert.match(drawer, /form="checklist-form"/);
  assert.match(drawer, /id="conversation-audio"/);
});
test("feed combines real dataset membership with dispute and channel filters", () => {
  const ids = (s) => feedRows(s).map((c) => c.conversation_id);
  assert.deepEqual(ids({ ...state, filter: "appeals" }), [original.conversation_id]);
  assert.deepEqual(ids({ ...state, filter: "voice", datasetIds: new Set(["another"]) }), []);
  assert.deepEqual(ids({ ...state, datasetIds: new Set(["another"]) }), ["another"]);
});
test("Gemini view replaces only aligned text and keeps original order, speaker and seek offsets", () => {
  const before = structuredClone(original);
  const gemini = {
    status: "done", model: "<Gemini>",
    messages: [
      { id: "system", text: "Поддельное служебное сообщение" },
      { id: original.messages[0].id, text: "<img src=x>", speaker: "client", offset_sec: 500, idx: 5 },
    ],
  };
  const html = transcriptMessages(original, gemini, "gemini");
  assert.match(html, /Оператор.*01:04.*&lt;img src=x&gt;/s);
  assert.match(html, /Служебное сообщение/);
  assert.doesNotMatch(html, /<img|Поддельное|08:20|Исходный текст/);
  assert.match(transcriptMessages(original, gemini, "original"), /Исходный текст/);
  assert.deepEqual(original, before);
});
test("transcription controls expose pending, backend errors, and actual model provenance", () => {
  const render = (transcription) => transcriptControls({ ...state, transcription, textMode: "original" });
  assert.match(render({ status: "running" }), /data-action="transcribe" disabled/);
  assert.match(render({ status: "error", error: "<img>" }), /role="alert">&lt;img&gt;/);
  assert.match(render({ status: "error" }), /Расшифровать Gemini/);
  const done = render({ status: "done", model: "actual-model" });
  assert.match(done, /actual-model/);
  assert.doesNotMatch(done, /data-action="transcribe"|data-transcript="gemini"[^>]+disabled/);
});
test("transcription POST starts the canonical async job and surfaces server errors", async () => {
  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    calls.push([url, request.method, request.body]);
    return calls.length === 1
      ? Response.json({ status: "running" }, { status: 202 })
      : Response.json({ error: "Нет доступной записи" }, { status: 422 });
  };
  try {
    assert.deepEqual(await api.transcribe("call/?1"), { status: "running" });
    await assert.rejects(api.transcription("call/?1"), (error) =>
      error instanceof ApiError && error.status === 422 && error.message === "Нет доступной записи");
    assert.deepEqual(calls, [
      ["/api/conversations/call%2F%3F1/transcription", "POST", '{"force":false}'],
      ["/api/conversations/call%2F%3F1/transcription", "GET", undefined],
    ]);
  } finally {
    globalThis.fetch = old;
  }
});

test("reevaluation sends the selected completed call transcript, and chats and batches use original", async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    calls.push({ url, method: request.method, ...JSON.parse(request.body) });
    return Response.json({ job_id: 1 }, { status: 202 });
  };
  const gemini = { ...state, textMode: "gemini", transcription: { status: "done" } };
  const chat = { ...gemini, detail: { ...state.detail, conversation: state.conversations[1] } };
  try {
    for (const view of [{ ...gemini, textMode: "original" }, gemini, chat]) {
      const source = evaluationTextSource(view);
      assert.ok(source);
      await api.evaluate([view.detail.conversation.conversation_id], 2, source);
    }
    await api.evaluate(["another", original.conversation_id], 2);
    assert.deepEqual(calls, [
      { url: "/api/evaluate", method: "POST", conversation_ids: [original.conversation_id], checklist_version_id: 2, transcript_source: "original" },
      { url: "/api/evaluate", method: "POST", conversation_ids: [original.conversation_id], checklist_version_id: 2, transcript_source: "gemini" },
      { url: "/api/evaluate", method: "POST", conversation_ids: ["another"], checklist_version_id: 2, transcript_source: "original" },
      { url: "/api/evaluate", method: "POST", conversation_ids: ["another", original.conversation_id], checklist_version_id: 2, transcript_source: "original" },
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("pending or stale Gemini disables reevaluation and leaves the score and citation on the stored basis", () => {
  const view = { ...state, textMode: "gemini", transcription: { status: "running" } };
  assert.equal(evaluationTextSource(view), null);
  assert.match(scorecard(view), /data-action="evaluate-one"[^>]*disabled/);
  assert.match(scorecard(view), /после завершения расшифровки/);
  const stale = { ...view, transcription: { status: "done" }, transcriptionStale: true };
  assert.equal(evaluationTextSource(stale), null);
  const html = scorecard(stale);
  assert.match(html, /Текст для оценки: исходный текст/);
  assert.match(html, /Сейчас открыт другой текст: расшифровка Gemini/);
  assert.match(html, /data-action="refresh"/);
  assert.match(html, />42<\/strong>/);
  assert.match(html, /data-evidence="first&quot;&lt;"/);
  assert.equal(evaluationTextSource({ ...stale, textMode: "original" }), "original");

  const fromGemini = scorecard({
    ...state,
    textMode: "original",
    detail: {
      ...state.detail,
      evaluation: { ...evaluation, transcript_source: "gemini", transcription_model: "<model>" },
    },
  });
  assert.match(fromGemini, /Текст для оценки: расшифровка Gemini · &lt;model&gt;/);
  assert.match(fromGemini, /Сейчас открыт другой текст: исходный текст/);
  assert.match(fromGemini, /Токены и стоимость API не измерялись/);
});

test("evaluate preserves the stale-transcription HTTP status for the workspace", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "Gemini transcription is missing or stale" }, { status: 409 });
  try {
    await assert.rejects(api.evaluate([original.conversation_id], 2, "gemini"),
      (error) => error instanceof ApiError && error.status === 409);
  } finally {
    globalThis.fetch = previous;
  }
});
