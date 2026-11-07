// LLM_PROVIDER=auto: Qwen on the GPU box while it answers, Gemini otherwise; per-job model pinning.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { openDatabase } from "./db.js";
import { saveConversations } from "./import.js";
import { createJobService, fakeEvaluate } from "./jobs.js";
import { aiRoutes } from "./routes/ai.js";
import { probe, registerEndpoint, resetRouter, activeProvider, ollamaUrl, ollamaHeaders } from "../ai/router.js";
import { modelName } from "../ai/evaluate.js";

const source = JSON.parse(readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)));
const env = ["LLM_PROVIDER", "OLLAMA_MODEL", "OLLAMA_URL", "OLLAMA_API_KEY", "OLLAMA_REGISTER_TOKEN", "OLLAMA_ENDPOINT_FILE", "GEMINI_MODEL"];
function withEnv(values, fn) {
  return async () => {
    const saved = Object.fromEntries(env.map((k) => [k, process.env[k]]));
    for (const k of env) delete process.env[k];
    Object.assign(process.env, values);
    resetRouter();
    try { await fn(); } finally {
      resetRouter();
      for (const k of env) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
}
const tags = (names, ok = true) => async (url, init) => {
  tags.last = { url: String(url), init };
  return { ok, status: ok ? 200 : 502, json: async () => ({ models: names.map((name) => ({ name })) }) };
};
const down = async () => { throw Error("connect ECONNREFUSED"); };

test("auto mode uses Gemini until the GPU box answers with the model, then Qwen, and back", withEnv(
  { LLM_PROVIDER: "auto", OLLAMA_MODEL: "qwen3.6:35b-a3b", GEMINI_MODEL: "gemini-x", OLLAMA_API_KEY: "gpu-secret" }, async () => {
    assert.equal(activeProvider(), "gemini");
    assert.equal(modelName(), "gemini-x");
    await probe({ fetchImpl: tags(["other:7b"]) });
    assert.equal(modelName(), "gemini-x", "a box without the model is not used");
    await probe({ fetchImpl: tags(["qwen3.6:35b-a3b"]) });
    assert.equal(modelName(), "ollama/qwen3.6:35b-a3b");
    assert.equal(tags.last.init.headers.authorization, "Bearer gpu-secret");
    await probe({ fetchImpl: down });
    assert.equal(modelName(), "gemini-x");
  }));

test("explicit providers are not affected by the router", withEnv({ LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m" }, async () => {
  assert.equal(modelName(), "ollama/m");
  assert.deepEqual(ollamaHeaders(), {});
}));

test("registration accepts only an https origin with the right token and switches the URL", withEnv(
  { LLM_PROVIDER: "auto", OLLAMA_MODEL: "q", OLLAMA_REGISTER_TOKEN: "reg-token" }, async () => {
    const app = express().use(express.json()).use("/api", aiRoutes())
      .use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/ai/ollama-endpoint`;
    const post = (auth, url) => fetch(base, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ url }) });
    try {
      assert.equal((await post(null, "https://a.trycloudflare.com")).status, 401);
      assert.equal((await post("Bearer wrong-token", "https://a.trycloudflare.com")).status, 401);
      assert.equal((await post("Bearer reg-token", "http://a.trycloudflare.com")).status, 400);
      assert.equal((await post("Bearer reg-token", "https://a.trycloudflare.com/api?x=1")).status, 400);
      const ok = await post("Bearer reg-token", "https://gpu-box.trycloudflare.com");
      assert.equal(ok.status, 200);
      assert.equal(ollamaUrl(), "https://gpu-box.trycloudflare.com");
    } finally { server.close(); }
  }));

test("registration route is absent without a token", withEnv({ LLM_PROVIDER: "auto" }, async () => {
  const app = express().use(express.json()).use("/api", aiRoutes())
    .use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/ollama-endpoint`, { method: "POST" });
    assert.equal(r.status, 404);
  } finally { server.close(); }
}));

test("auto mode pins each job to the provider online at submit time", withEnv(
  { LLM_PROVIDER: "auto", OLLAMA_MODEL: "q", GEMINI_MODEL: "g" }, async () => {
    const db = openDatabase(":memory:");
    saveConversations(db, [source], "DEV");
    const seen = [];
    const service = createJobService(db, { evaluate: async (c, cs, meta) => { seen.push(meta.model); return fakeEvaluate(c, cs); } });
    const finish = async (id) => {
      for (let i = 0; i < 200; i++) { const j = service.get(id); if (["done", "error"].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 5)); }
      throw Error("timeout");
    };
    const first = service.submit({ checklist_version_id: 1, conversation_ids: [source.conversation_id] });
    assert.equal((await finish(first.job_id)).status, "done");
    await registerEndpoint("https://gpu-box.trycloudflare.com", { fetchImpl: tags(["q"]) });
    const second = service.submit({ checklist_version_id: 1, conversation_ids: [source.conversation_id] });
    assert.equal((await finish(second.job_id)).status, "done");
    assert.deepEqual(seen, ["g", "ollama/q"]);
    const models = db.prepare("SELECT model FROM evaluations ORDER BY id").all().map((r) => r.model);
    assert.deepEqual(models, ["g", "ollama/q"]);
    await service.close();
    db.close();
  }));
