import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateResult as serverValidate } from "./scoring.js";
import { validateResult as aiValidate } from "../ai/validate.js";
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../shared/${name}`, import.meta.url)));
const checklist = load("checklist.default.json"),
  conversation = load("mocks/conversation.json"),
  mock = load("mocks/evaluation.json");
test("server and AI validators agree on the complete CriterionResult contract", () => {
  const cases = [];
  for (const c of checklist.criteria) {
    const r = mock.criteria.find((r) => r.criterion_id === c.id).original;
    cases.push([c, r, true]);
    for (const patch of [
      { criterion_id: "wrong" },
      { checked_range: false },
      { checked_range: "" },
      { checked_range: 0 },
      { explanation: 42 },
      { evidence_ids: "m004" },
      { evidence_ids: [42] },
      { evidence_ids: ["m999"] },
      { checked_range: { from: "m009", to: "m001" } },
      { checked_range: { from: "m001", to: "missing" } },
      { answer: "wrong" },
      { answer: "na", scale_value: 7 },
    ])
      cases.push([c, { ...r, ...patch }, false]);
    cases.push([c, { ...r, answer: "na", scale_value: null, checked_range: null }, c.na_allowed]);
    cases.push([
      c,
      { ...r, answer: "no", scale_value: null, checked_range: null },
      c.type === "binary" && !!c.gross_error,
    ]);
    if (c.type === "binary")
      cases.push([c, { ...r, answer: "yes", scale_value: 10 }, false]);
    else
      cases.push([
        c,
        { ...r, answer: "yes", scale_value: c.scale[0].value },
        false,
      ]);
  }
  for (const [c, r, expected] of cases) {
    let server = true;
    try {
      serverValidate(c, r, conversation);
    } catch {
      server = false;
    }
    const ai = aiValidate(r, c, conversation).length === 0;
    assert.equal(server, expected, `${c.id} server ${JSON.stringify(r)}`);
    assert.equal(ai, expected, `${c.id} AI ${JSON.stringify(r)}`);
  }
});
