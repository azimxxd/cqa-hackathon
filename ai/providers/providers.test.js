import test from "node:test";
import assert from "node:assert/strict";
import { generate as gemini } from "./gemini.js";
import { generate as ollama } from "./ollama.js";
import { evaluateConversation } from "../evaluate.js";
import { normalize } from "../validate.js";
import { readFileSync } from "node:fs";
const load = (n) =>
  JSON.parse(readFileSync(new URL(`../../shared/${n}`, import.meta.url)));
async function stub(fn) {
  const previous = fetch,
    env = { ...process.env };
  process.env.GEMINI_API_KEY = "stub";
  process.env.GEMINI_MAX_ATTEMPTS = "2";
  process.env.GEMINI_MAX_BACKOFF_MS = "0";
  process.env.OLLAMA_MAX_BACKOFF_MS = "0";
  process.env.LLM_PROVIDER = "gemini";
  try {
    await fn();
  } finally {
    globalThis.fetch = previous;
    for (const k of Object.keys(process.env))
      if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
}
for (const [name, generate, attempts] of [
  ["gemini", gemini, 2],
  ["ollama", ollama, 3],
]) {
  test(`${name}: network and 503 retries preserve status, attempts and call logs`, () =>
    stub(async () => {
      for (const kind of ["network", "503"]) {
        let n = 0;
        globalThis.fetch = async () => {
          n++;
          if (kind === "network") throw Error("network down");
          return new Response("busy", { status: 503 });
        };
        await assert.rejects(generate({ system: "s", user: "u" }), (e) => {
          assert.equal(e.provider, name);
          assert.equal(e.retryable, true);
          assert.equal(e.status, kind === "503" ? 503 : 0);
          assert.equal(e.calls.length, attempts);
          return true;
        });
        assert.equal(n, attempts);
      }
    }));
  test(`${name}: fatal 400 and malformed JSON are logged without retry`, () =>
    stub(async () => {
      for (const status of [400, 200]) {
        let n = 0;
        globalThis.fetch = async () => {
          n++;
          return new Response("not json", { status });
        };
        await assert.rejects(generate({ system: "s", user: "u" }), (e) => {
          assert.equal(e.status, status);
          assert.equal(e.fatal, true);
          assert.equal(e.calls.length, 1);
          return true;
        });
        assert.equal(n, 1);
      }
    }));
}
test("AI invalidResult exposes errors, partial answers and all successful HTTP logs", () =>
  stub(async () => {
    const c = load("checklist.default.json"),
      conv = load("mocks/conversation.json"),
      mock = load("mocks/evaluation.json");
    let n = 0;
    globalThis.fetch = async (_url, init) => {
      n++;
      const ids = JSON.parse(init.body).generationConfig.responseSchema
        .properties.results.items.properties.criterion_id.enum;
      const results = ids.map((id) => ({
        ...mock.criteria.find((r) => r.criterion_id === id).original,
        ...(id === "c04"
          ? { scale_value: 13 }
          : id === "c01"
            ? { answer: "na" }
            : {}),
      }));
      return Response.json({
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ results }) }] } },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    };
    await assert.rejects(
      evaluateConversation(conv, c.criteria, c, { noCache: true }),
      (e) => {
        assert.equal(e.invalidResult, true);
        assert.deepEqual(e.criteria, ["c01", "c04"]);
        assert.equal(e.details.length, 2);
        assert.equal(e.partial.length, 6);
        assert.equal(e.calls.length, 2);
        return true;
      },
    );
    assert.equal(n, 2);
  }));
test("evidence normalization supports strings and discards other non-arrays", () => {
  const c = load("checklist.default.json").criteria[0],
    conv = load("mocks/conversation.json");
  for (const [value, expected] of [
    ["m004", ["m004"]],
    [42, []],
    [{}, []],
    [null, []],
  ])
    assert.deepEqual(
      normalize({ criterion_id: c.id, evidence_ids: value }, c, conv)
        .evidence_ids,
      expected,
    );
});

test("standalone cache revalidates N/A policy changes with the same semantic hash", () =>
  stub(async () => {
    const c = load("checklist.default.json").criteria[1],
      conv = {
        ...load("mocks/conversation.json"),
        conversation_id: "standalone-na-policy",
      };
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    results: [
                      {
                        criterion_id: c.id,
                        answer: n === 1 ? "na" : "yes",
                        scale_value: null,
                        explanation: "synthetic",
                        evidence_ids: [],
                        checked_from: null,
                        checked_to: null,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      });
    };
    await evaluateConversation(conv, [c]);
    const response = await evaluateConversation(conv, [
      { ...c, na_allowed: false },
    ]);
    assert.equal(n, 2);
    assert.equal(response.results[0].answer, "yes");
  }));

test("successful HTTP with malformed Gemini content keeps all logs and gets only a validation retry", () =>
  stub(async () => {
    const checklist = load("checklist.default.json"),
      conv = load("mocks/conversation.json");
    for (const payload of [
      null,
      { candidates: [{ content: { parts: 42 } }] },
      { candidates: [{ content: { parts: [null] } }] },
    ]) {
      let n = 0;
      globalThis.fetch = async () => {
        n++;
        return Response.json(payload);
      };
      await assert.rejects(
        evaluateConversation(conv, checklist.criteria, checklist, {
          noCache: true,
        }),
        (error) => {
          assert.equal(error.invalidResult, true);
          assert.equal(error.calls.length, 2);
          return true;
        },
      );
      assert.equal(n, 2);
    }
  }));
