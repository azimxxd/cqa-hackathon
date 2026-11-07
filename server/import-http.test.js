import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fixture } from "./fixtures.js";
test("POST import fetches organizers and exposes saved conversation through GET", async () => {
  const sample = JSON.parse(
    readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
  );
  sample.conversation_id = "from-organizers";
  let success = true;
  const org = createServer((req, res) => {
    assert.equal(
      new URL(req.url, "http://localhost").searchParams.get("group_id"),
      "TEST",
    );
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ isSuccess: success, data: [sample] }));
  }).listen(0);
  await new Promise((r) => org.once("listening", r));
  const previous = process.env.ORG_API_URL;
  process.env.ORG_API_URL = `http://127.0.0.1:${org.address().port}/transcripts`;
  try {
    await fixture(async (request) => {
      assert.equal((await request("/import", {})).status, 400);
      assert.deepEqual((await request("/import", { group_id: "TEST" })).body, {
        imported: 1,
      });
      assert.deepEqual(
        (await request("/conversations/from-organizers")).body,
        sample,
      );
      assert.equal(
        (await request("/import", { group_id: "TEST" })).body.imported,
        1,
      );
      success = false;
      assert.equal(
        (await request("/import", { group_id: "TEST" })).status,
        502,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.ORG_API_URL;
    else process.env.ORG_API_URL = previous;
    await new Promise((r) => org.close(r));
  }
});
