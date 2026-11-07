import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url)));

test("truncated disk cache is reevaluated and persists a valid replacement for the next process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cqa-ai-cache-"));
  const previousFetch = globalThis.fetch,
    env = { ...process.env };
  Object.assign(process.env, {
    AI_CACHE_DIR: dir,
    GEMINI_API_KEY: "stub",
    LLM_PROVIDER: "gemini",
  });
  const conversation = {
    ...load("mocks/conversation.json"),
    conversation_id: "disk-cache-recovery",
  };
  const criterion = load("checklist.default.json").criteria[0];
  const result = load("mocks/evaluation.json").criteria[0].original;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ results: [result] }) }] },
        },
      ],
    });
  };
  try {
    const first = await import("./evaluate.js?cache-test=initial");
    await first.evaluateConversation(conversation, [criterion]);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    writeFileSync(join(dir, files[0]), '{"criterion_id":');
    const fresh = await import("./evaluate.js?cache-test=restarted");
    const repaired = await fresh.evaluateConversation(conversation, [
      criterion,
    ]);
    assert.equal(requests, 2);
    assert.deepEqual(repaired.results, [result]);
    assert.equal(repaired.cached_count, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, files[0]), "utf8")),
      result,
    );
    assert.deepEqual(readdirSync(dir), files);
    const restartedAgain =
      await import("./evaluate.js?cache-test=restarted-again");
    const cached = await restartedAgain.evaluateConversation(conversation, [
      criterion,
    ]);
    assert.equal(requests, 2);
    assert.equal(cached.cached_count, 1);
    assert.deepEqual(cached.calls, []);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});
