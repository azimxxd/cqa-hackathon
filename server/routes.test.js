import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./test-helpers.js";
const conversation = JSON.parse(
  readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
);
test("real routes return persisted conversations and immutable checklist versions", () =>
  fixture(async (request) => {
    assert.deepEqual(
      (await request("/conversations/mock-ru-001")).body,
      conversation,
    );
    assert.equal((await request("/conversations")).body[0].total, null);
    assert.equal((await request("/conversations/missing")).status, 404);
    const first = (await request("/checklists/latest")).body;
    const next = await request("/checklists", { ...first, name: "new" });
    assert.equal(next.status, 201);
    assert.equal(next.body.id, 2);
    assert.equal((await request("/checklists/1")).body.name, first.name);
    assert.equal(
      (
        await request("/checklists", {
          ...first,
          criteria: [{ ...first.criteria[0], weight: -1 }],
        })
      ).status,
      400,
    );
    assert.equal((await request("/evaluations")).status, 404);
  }));
