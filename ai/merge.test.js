// Teammate scenarios retained when merging origin/main, using the shared strict contract.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, validateResult } from "./validate.js";
import { evaluateConversation, toConversation, costUsd } from "./evaluate.js";
import { toPlainSchema } from "./providers/ollama.js";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url)));
const checklist = load("checklist.default.json");
const conversation = load("mocks/conversation.json");
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("No network in merge tests");
};
after(() => {
  globalThis.fetch = previousFetch;
});

test("merge: long client greetings do not override a permitted model N/A", () => {
  const conv = toConversation({
    transcript: [
      {
        timestamp: "00:00",
        speaker: "client",
        text: "Здравствуйте! Подключите, пожалуйста, живого оператора поддержки, мне нужна помощь.",
      },
      {
        timestamp: "00:20",
        speaker: "operator",
        text: "Здравствуйте, я Анна. Чем помочь?",
      },
      { timestamp: "00:30", speaker: "system", text: "Клиент покинул чат." },
    ],
  });
  const criterion = checklist.criteria[3];
  const result = normalize(
    {
      criterion_id: criterion.id,
      answer: "na",
      scale_value: null,
      explanation: "Клиент ушёл.",
      evidence_ids: ["m003"],
    },
    criterion,
    conv,
  );
  assert.equal(result.answer, "na");
  assert.equal(result.scale_value, null);
  assert.deepEqual(validateResult(result, criterion, conv), []);
});

test("merge: whitespace and boolean scale values cannot become valid zero scores", () => {
  const criterion = checklist.criteria[3];
  for (const value of ["   ", false, true]) {
    const result = normalize(
      {
        criterion_id: criterion.id,
        answer: null,
        scale_value: value,
        explanation: "synthetic",
        evidence_ids: ["m004"],
      },
      criterion,
      conversation,
    );
    assert.notEqual(result.scale_value, 0);
    assert.ok(validateResult(result, criterion, conversation).length > 0);
  }
  assert.equal(
    normalize({ scale_value: "   " }, criterion, conversation).scale_value,
    null,
  );
});

test("merge: nonexistent evidence gets feedback; persistently broken JSON remains an error", async () => {
  const criterion = checklist.criteria[0];
  let attempts = 0;
  const provider = {
    async generate({ user }) {
      attempts++;
      if (attempts === 2) assert.match(user, /m999/);
      return {
        model: "stub",
        input_tokens: 10,
        output_tokens: 5,
        text: JSON.stringify({
          results: [
            {
              criterion_id: criterion.id,
              answer: "yes",
              scale_value: null,
              explanation: "synthetic",
              evidence_ids: [attempts === 1 ? "m999" : "m004"],
            },
          ],
        }),
      };
    },
  };
  const result = await evaluateConversation(
    conversation,
    [criterion],
    checklist,
    { noCache: true, provider },
  );
  assert.equal(attempts, 2);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.results[0].evidence_ids, ["m004"]);
  attempts = 0;
  await assert.rejects(
    evaluateConversation(conversation, [criterion], checklist, {
      noCache: true,
      provider: {
        async generate() {
          attempts++;
          return { model: "stub", text: "<<<NOT_JSON_AT_ALL" };
        },
      },
    }),
    (error) => {
      assert.equal(error.invalidResult, true);
      assert.equal(error.calls.length, 2);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test("merge: blank price settings use defaults while explicit zero remains zero", () => {
  const names = ["PRICE_INPUT_PER_M", "PRICE_OUTPUT_PER_M"];
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.PRICE_INPUT_PER_M = "";
    process.env.PRICE_OUTPUT_PER_M = "  ";
    assert.equal(costUsd("stub", 2000, 500), 0.00125);
    for (const name of names) process.env[name] = "0";
    assert.equal(costUsd("stub", 2000, 500), 0);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("merge: Ollama nullable schema supports unions without nested or duplicate types", () => {
  const schema = {
    type: ["string", "null"],
    nullable: true,
    enum: ["yes", null],
  };
  assert.deepEqual(toPlainSchema(schema), {
    type: ["string", "null"],
    enum: ["yes", null],
  });
  assert.deepEqual(toPlainSchema({ type: "number", nullable: true }), {
    type: ["number", "null"],
  });
});

test("Qwen rechecks official clarity and closing while preserving the initial batch and jury rules", async () => {
  const selected = checklist.criteria.filter(c => ["c01", "c06", "c07"].includes(c.id));
  const run = async criteria => {
    const requests = [];
    const output = await evaluateConversation(
      conversation,
      criteria,
      { ...checklist, model: "ollama/qwen3.6:35b-a3b" },
      {
        noCache: true,
        samples: 1,
        provider: {
          async generate({ schema }) {
            const ids = schema.properties.results.items.properties.criterion_id.enum;
            requests.push(ids);
            return {
              text: JSON.stringify({
                results: ids.map(id => ({
                  criterion_id: id,
                  answer: id === "c06" ? null : "yes",
                  scale_value: id === "c06" ? (ids.length === 1 ? 7 : 10) : null,
                  explanation: "Тестовое основание.",
                  evidence_ids: id === "clarification_check" ? ["m004", "m006"] : ["m004"],
                })),
              }),
            };
          },
        },
      },
    );
    assert.deepEqual(output.results.map(c => c.criterion_id), ["c01", "c06", "c07"]);
    assert.equal(output.results[1].scale_value, 4);
    assert.deepEqual(output.results[1].checked_range, { from: "m004", to: "m006" });
    return requests;
  };
  assert.deepEqual(await run(selected), [["c01", "c06", "c07"], ["c06"], ["clarification_check"], ["c07"]]);
  const custom = selected.map(c => c.id === "c07" ? { ...c, description: "Правило жюри" } : c);
  assert.deepEqual(await run(custom), [["c01", "c06", "c07"], ["c06"], ["clarification_check"]]);
});
