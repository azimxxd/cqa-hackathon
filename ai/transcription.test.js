import assert from "node:assert/strict";
import { test } from "node:test";
import { alignTranscription, transcribe } from "./transcription.js";

const messages = [
  { id: "m001", text: "Connected", speaker: "system", idx: 0, offset_sec: 0 },
  { id: "m002", text: "Phone [PHONE]", speaker: "client", idx: 1, offset_sec: 1 },
  { id: "m003", text: "Hello?", speaker: "operator", idx: 2, offset_sec: 2 },
];
const items = [
  { id: "m003", text: "Hello!", speaker: "client", offset_sec: 999 },
  { id: "m002", text: "Phone 123456789" },
  { id: "m001", text: "Invented speech" },
];

test("alignment retains source metadata, system text and redacted lines", () => {
  assert.deepEqual(alignTranscription(messages, items), [
    messages[0], messages[1], { ...messages[2], text: "Hello!" },
  ]);
  const protectedOutput = alignTranscription(messages, [
    { ...items[0], text: "Repeat: +7 123 456 78 90, person@example.test" }, ...items.slice(1),
  ]);
  assert.equal(protectedOutput[2].text, "Repeat: [Персональные данные скрыты], [Персональные данные скрыты]");
  for (const bad of [
    items.slice(1),
    [...items.slice(0, 2), items[0]],
    [...items.slice(0, 2), { id: "other", text: "Hello" }],
    [...items.slice(0, 2), { id: "m001", text: " " }],
  ]) assert.throws(() => alignTranscription(messages, bad), /transcript/);
});

test("Gemini sends inline MPEG and a schema, rotates keys and retries transient errors", async (t) => {
  const settings = { GEMINI_API_KEYS: "test-first,test-second", GEMINI_MAX_ATTEMPTS: "3", GEMINI_MAX_BACKOFF_MS: "0" };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const attempts = [];
  const audio = Buffer.from("ID3 fixture");
  t.mock.method(globalThis, "fetch", async (url, init) => {
    attempts.push({ url, init });
    if (attempts.length <= 2) return new Response("test-private-response", { status: attempts.length === 1 ? 403 : 429 });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ items: Object.fromEntries(items.map(m => [m.id, m.text])) }) }] } }] });
  });
  const model = "gemini-test";
  assert.deepEqual(await transcribe({ audio, messages, model }), alignTranscription(messages, items));
  assert.deepEqual(attempts.map(({ init }) => init.headers["x-goog-api-key"]), ["test-first", "test-second", "test-first"]);
  for (const { url, init } of attempts) {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents[0].parts[0].inlineData, { mimeType: "audio/mpeg", data: audio.toString("base64") });
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    const boundaries = JSON.parse(body.contents[0].parts[1].text);
    assert.equal(boundaries[2].text, undefined, "do not leak unmasked source wording into ASR");
    assert.equal(boundaries[1].text, messages[1].text);
    assert.deepEqual(body.generationConfig.responseSchema.required, ["items"]);
  }
});

test("long recordings are aligned in bounded chunks without losing original positions", async (t) => {
  const saved = process.env.GEMINI_API_KEYS;
  process.env.GEMINI_API_KEYS = "test-key";
  t.after(() => saved === undefined ? delete process.env.GEMINI_API_KEYS : process.env.GEMINI_API_KEYS = saved);
  const source = Array.from({ length: 115 }, (_, i) => ({ id: `m${String(i + 1).padStart(3, "0")}`,
    idx: i, offset_sec: i * 3, speaker: "operator", text: `source ${i}` }));
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body), requested = JSON.parse(body.contents[0].parts[1].text);
    chunks.push(requested);
    assert.deepEqual(body.generationConfig.responseSchema.properties.items.required, requested.map(m => m.id));
    assert.equal(Object.keys(body.generationConfig.responseSchema.properties.items.properties).length, requested.length);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      items: Object.fromEntries(requested.map(m => [m.id, `heard ${m.idx}`])),
    }) }] } }] });
  });
  const aligned = await transcribe({ audio: Buffer.from("ID3 fixture"), messages: source, model: "gemini-test" });
  assert.deepEqual(chunks.map(c => c.length), [50, 50, 15]);
  assert.equal(aligned.length, 115);
  assert.deepEqual(aligned.map(m => [m.id, m.idx, m.offset_sec]), source.map(m => [m.id, m.idx, m.offset_sec]));
  assert.equal(aligned[100].text, "heard 100");
});


test("keypad events keep their client role and digit when ASR shifts an automated prompt", () => {
  const keypad = { id: "m004", text: "2", speaker: "client", idx: 3, offset_sec: 16 };
  assert.deepEqual(alignTranscription([keypad], [{ id: "m004", text: "For Russian press two" }]), [keypad]);
});
