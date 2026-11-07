import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { getChecklist, openDatabase, saveChecklist } from "./db.js";
import { saveConversations } from "./import.js";
import { createApp } from "./app.js";
import { createJobService, fakeEvaluate } from "./jobs.js";
import { getEvaluation } from "./evaluations.js";

const recording = Buffer.from("ID3 recording fixture");
const input = {
  conversation_id: "p4-ru-001", channel: "voice call", language: "ru",
  messages: [
    { speaker: "system", timestamp: "2026-01-01T00:00:00Z", text: "Connected" },
    { speaker: "operator", timestamp: "2026-01-01T00:00:03Z", text: "Original transcript" },
  ],
};
const originalUrl = "https://example.test/flow?sig=private-test";
const remoteId = "../remote";

test("playback, real Gemini request lifecycle, persistent invalidation and safe failures", async (t) => {
  const fetch = globalThis.fetch;
  const settings = ["GEMINI_API_KEYS", "GEMINI_API_Keys", "GEMINI_API_KEY", "GEMINI_TRANSCRIBE_MODEL"];
  const previous = settings.map((key) => process.env[key]);
  settings.forEach((key) => delete process.env[key]);
  t.after(() => settings.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  const directory = await mkdtemp(join(tmpdir(), "cqa-audio-"));
  const filename = join(directory, "p4-ru-001.mp3");
  await writeFile(filename, recording);
  const dbFile = join(directory, "test.db");
  let db = openDatabase(dbFile);
  saveConversations(db, [
    input,
    { ...input, conversation_id: remoteId, audio_url: originalUrl },
    { ...input, conversation_id: "no-audio" },
    { ...input, conversation_id: "chat", channel: "agent chat",
      messages: [{ speaker: "client", timestamp: "00:00", text: "Chat original" }] },
    { ...input, conversation_id: "inline", audio_url: "https://example.test/inline" },
    { ...input, conversation_id: "invalid-audio", audio_url: "https://example.test/invalid" },
  ], "DEV");

  let calls = 0;
  let failure = false;
  let geminiText = "Gemini audio transcript";
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    await gate;
    if (failure) return new Response("private-test", { status: 400 });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{
      text: JSON.stringify({ items: { m002: geminiText, m001: "Ignored replacement" } }),
    }] } }] });
  });

  const assessments = [];
  const remoteRequests = [];
  let app, server;
  async function start() {
    app = createApp(db, {
      jobs: {
        model: "assessment-model",
        evaluate(conversation, criteria, checklist) {
          assessments.push({ conversation, criteria, checklist });
          return fakeEvaluate(conversation, criteria);
        },
      },
      transcription: { audio: {
      directory,
      fetcher: async (url) => {
        remoteRequests.push(url.href);
        if (url.href === originalUrl) return Response.json({ body: { downloadUrl: "/file" } });
        if (url.pathname === "/inline") return Response.json({ body: {
          "$content-type": "audio/mpeg", "$content": recording.toString("base64"),
        } });
        return new Response(url.pathname === "/file" ? recording : "this is not audio", {
          headers: { "content-type": "audio/mpeg" },
        });
      },
    } } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
  }
  async function stop() {
    await app.locals.transcription.close();
    await app.locals.jobs.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    server = null;
  }
  const request = (path, init) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, init);
  const path = "/conversations/p4-ru-001/transcription";
  const status = async (endpoint = path) => (await request(endpoint)).json();
  const post = (endpoint = path, force = false) => request(endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force }),
  });
  const evaluationRequest = (source, ids = [input.conversation_id], version = 1) =>
    request("/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript_source: source, conversation_ids: ids, checklist_version_id: version }),
    });
  async function evaluate(source, version = 1, ids) {
    const response = await evaluationRequest(source, ids, version);
    assert.equal(response.status, 202);
    const { job_id } = await response.json();
    const job = await settled(`/jobs/${job_id}`);
    assert.equal(job.status, "done", JSON.stringify(job.errors));
    return status(`/evaluations?conversation_id=${input.conversation_id}&version=${version}`);
  }
  async function settled(endpoint = path) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await status(endpoint);
      if (!["queued", "running"].includes(current.status)) return current;
      await setTimeout(10);
    }
    assert.fail("Transcription did not settle");
  }

  try {
    await start();
    assert.equal((await status("/ai/status")).transcription_configured, false);
    assert.equal((await post()).status, 503);
    process.env.GEMINI_API_KEYS = "private-test";
    const config = await status("/ai/status");
    assert.equal(config.transcription_configured, true);
    assert.equal(config.transcription_model, "gemini-3.1-flash-lite");
    assert.doesNotMatch(JSON.stringify(config), /private-test/);
    assert.equal((await post("/conversations/no-audio/transcription")).status, 404);
    const source = await status("/conversations/p4-ru-001");

    for (const [range, bytes, expected] of [
      [undefined, recording, 200],
      ["bytes=1-3", recording.subarray(1, 4), 206],
      ["bytes=-4", recording.subarray(-4), 206],
      ["bytes=2-", recording.subarray(2), 206],
      ["bytes=999-", Buffer.alloc(0), 416],
      ["wrong", Buffer.alloc(0), 416],
    ]) {
      const response = await request("/audio/p4-ru-001", { headers: range ? { Range: range } : {} });
      assert.equal(response.status, expected);
      if (range === "bytes=1-3") assert.equal(response.headers.get("content-range"), `bytes 1-3/${recording.length}`);
      if (expected === 416) assert.equal(response.headers.get("content-range"), `bytes */${recording.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }

    assert.equal((await status()).status, "missing");
    assert.equal((await evaluationRequest("gemini", [input.conversation_id, "no-audio"])).status, 409);
    assert.equal((await evaluationRequest("unknown")).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM evaluations").get().n, 0);
    const firstAssessment = await evaluate();
    assert.equal(firstAssessment.transcript_source, "original");
    assert.equal(firstAssessment.transcription_model, null);
    assert.deepEqual(assessments[0].conversation.messages, source.messages);
    const started = await post();
    assert.equal(started.status, 202);
    assert.equal((await started.json()).status, "running");
    assert.equal((await post(path, true)).status, 202);
    assert.equal((await status()).status, "running");
    unblock();
    const result = await settled();
    assert.equal(result.status, "done");
    assert.deepEqual(result.messages, [
      source.messages[0],
      { ...source.messages[1], text: "Gemini audio transcript" },
    ]);
    assert.deepEqual(await status("/conversations/p4-ru-001"), source);
    assert.equal(calls, 1);
    assert.deepEqual(await (await post()).json(), result);
    assert.equal(calls, 1);

    const firstGemini = await evaluate("gemini");
    assert.equal(firstGemini.transcript_source, "gemini");
    assert.equal(firstGemini.transcription_model, result.model);
    assert.notEqual(firstGemini.transcript_hash, firstAssessment.transcript_hash);
    assert.deepEqual(assessments[1].conversation.messages, result.messages);
    assert.equal(assessments[1].criteria.length, getChecklist(db, 1).criteria.length);
    assert.deepEqual(await status(`/evaluations/${firstAssessment.id}`), firstAssessment);
    const version = getChecklist(db, 1);
    version.criteria[0].weight++;
    const secondVersion = saveChecklist(db, version).id;
    const reused = await evaluate("gemini", secondVersion);
    assert.equal(reused.checklist_version_id, secondVersion);
    assert.deepEqual(reused.evaluated_criteria, []);
    assert.equal(assessments.length, 2);

    geminiText = "Changed Gemini transcript";
    assert.equal((await post(path, true)).status, 202);
    const changedTranscript = await settled();
    const changed = await evaluate("gemini", secondVersion);
    assert.notEqual(changed.transcript_hash, firstGemini.transcript_hash);
    assert.deepEqual(assessments[2].conversation.messages, changedTranscript.messages);
    assert.deepEqual(changed.evaluated_criteria, getChecklist(db, secondVersion).criteria.map(({ id }) => id));
    assert.deepEqual(await status(`/evaluations/${firstGemini.id}`), firstGemini);
    const originalAgain = await evaluate("original", secondVersion);
    assert.deepEqual(originalAgain.evaluated_criteria, []);
    assert.equal(assessments.length, 3);
    await evaluate("gemini", secondVersion, [input.conversation_id, "chat"]);
    const chat = await status(`/evaluations?conversation_id=chat&version=${secondVersion}`);
    assert.equal(chat.transcript_source, "original");
    assert.equal(chat.transcription_model, null);
    assert.equal(assessments[3].conversation.messages[0].text, "Chat original");
    const count = db.prepare("SELECT COUNT(*) n FROM evaluations").get().n;
    assert.equal((await evaluationRequest("gemini", [input.conversation_id, "no-audio"])).status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM evaluations").get().n, count);

    await stop();
    db = openDatabase(dbFile);
    await start();
    assert.deepEqual(await status(), changedTranscript);
    process.env.GEMINI_TRANSCRIBE_MODEL = "gemini-different";
    assert.equal((await evaluationRequest("gemini")).status, 409);
    assert.equal((await status()).status, "missing");
    delete process.env.GEMINI_TRANSCRIBE_MODEL;
    await writeFile(filename, Buffer.from("ID3 changed audio"));
    assert.equal((await status()).status, "missing");
    await writeFile(filename, recording);
    db.prepare("UPDATE messages SET text = ? WHERE conversation_id = ? AND id = ?")
      .run("Changed source", input.conversation_id, "m002");
    assert.equal((await status()).status, "missing");

    assert.equal((await post()).status, 202);
    assert.equal((await settled()).status, "done");
    failure = true;
    assert.equal((await post(path, true)).status, 202);
    const errored = await settled();
    assert.equal(errored.status, "error");
    assert.match(errored.error, /Gemini.*HTTP 400/);
    assert.doesNotMatch(JSON.stringify(errored), /private-test/);
    failure = false;
    assert.equal((await post()).status, 202);
    assert.equal((await settled()).status, "done");

    const remotePath = `/audio/${encodeURIComponent(remoteId)}`;
    for (let i = 0; i < 2; i++) {
      const remote = await request(remotePath);
      assert.equal(remote.status, 200);
      assert.deepEqual(Buffer.from(await remote.arrayBuffer()), recording);
    }
    assert.deepEqual(remoteRequests, [originalUrl, "https://example.test/file"]);
    const inline = await request("/audio/inline");
    assert.equal(inline.status, 200);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), recording);
    const invalidPath = "/conversations/invalid-audio/transcription";
    assert.equal((await post(invalidPath)).status, 202);
    assert.match((await settled(invalidPath)).error, /not an MP3/);
    assert.equal(calls, 5);
  } finally {
    unblock();
    if (server) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued Gemini assessment resumes with its accepted snapshot after SQLite reopens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cqa-gemini-queue-"));
  const filename = join(directory, "test.db");
  let db = openDatabase(filename);
  let service, release;
  try {
    const chat = { ...input, conversation_id: "blocker", channel: "agent chat",
      messages: [{ speaker: "client", timestamp: "00:00", text: "Chat original" }] };
    saveConversations(db, [input, chat], "DEV");
    const gate = new Promise((resolve) => { release = resolve; });
    service = createJobService(db, {
      model: "assessment-model",
      concurrency: 1,
      async evaluate(conversation, criteria) {
        assert.equal(conversation.conversation_id, "blocker");
        await gate;
        return fakeEvaluate(conversation, criteria);
      },
      resolveTranscription(conversation) {
        return { model: "transcription-model", messages: conversation.messages.map((message) =>
          message.speaker === "operator" ? { ...message, text: "Accepted Gemini snapshot" } : message) };
      },
    });
    service.submit({ conversation_ids: ["blocker"], checklist_version_id: 1 });
    const { job_id } = await service.submit({
      conversation_ids: [input.conversation_id], checklist_version_id: 1, transcript_source: "gemini",
    });
    assert.equal(service.get(job_id).status, "queued");
    const closing = service.close();
    release();
    await closing;
    db.close();

    db = openDatabase(filename);
    let assessed;
    service = createJobService(db, {
      model: "assessment-model",
      evaluate(conversation, criteria) {
        assessed = conversation;
        return fakeEvaluate(conversation, criteria);
      },
      resolveTranscription() { assert.fail("Restart should use the accepted snapshot"); },
    });
    for (let i = 0; i < 100 && ["queued", "running"].includes(service.get(job_id).status); i++)
      await setTimeout(10);
    assert.equal(service.get(job_id).status, "done");
    assert.equal(assessed.messages[1].text, "Accepted Gemini snapshot");
    assert.equal(assessed.messages[1].id, "m002");
    assert.equal(assessed.messages[1].offset_sec, 3);
    const result = getEvaluation(db, 2);
    assert.equal(result.transcript_source, "gemini");
    assert.equal(result.transcription_model, "transcription-model");
    assert.match(result.transcript_hash, /^[a-f0-9]{64}$/);
  } finally {
    release?.();
    await service?.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
