import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase } from "./db.js";
import {
  normalizeConversation,
  saveConversations,
  getConversation,
  importGroup,
} from "./import.js";
const sample = JSON.parse(
  readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
);
test("import assigns stable IDs, preserves timestamps, rejects changing existing content atomically", () => {
  const db = openDatabase(":memory:");
  try {
    saveConversations(db, [sample], "DEV");
    saveConversations(db, [sample], "DEV");
    assert.deepEqual(getConversation(db, sample.conversation_id), sample);
    assert.throws(() =>
      saveConversations(
        db,
        [
          { ...sample, conversation_id: "new" },
          { ...sample, messages: [] },
        ],
        "DEV",
      ),
    );
    assert.equal(getConversation(db, "new"), null);
    const voice = normalizeConversation({
      ...sample,
      channel: "voice call",
      messages: [
        { ...sample.messages[0], timestamp: "2026-11-08T10:00:00+05:00" },
        { ...sample.messages[1], timestamp: "2026-11-08T05:01:30Z" },
      ],
    });
    assert.equal(voice.messages[1].offset_sec, 90);
    assert.throws(() =>
      normalizeConversation({
        ...voice,
        messages: [{ ...voice.messages[0], timestamp: "2026-11-08T10:00:00" }],
      }),
    );
  } finally {
    db.close();
  }
});
test("organizers GET includes group_id and requires success", async () => {
  const db = openDatabase(":memory:");
  try {
    const imported = await importGroup(db, "DEV", {
      url: "https://example.test/api?x=1",
      fetchImpl: async (url) => {
        assert.equal(url.searchParams.get("group_id"), "DEV");
        return {
          ok: true,
          json: async () => ({ isSuccess: true, data: [sample] }),
        };
      },
    });
    assert.equal(imported, 1);
    await assert.rejects(
      importGroup(db, "DEV", {
        url: "https://example.test",
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ isSuccess: false }),
        }),
      }),
    );
  } finally {
    db.close();
  }
});
