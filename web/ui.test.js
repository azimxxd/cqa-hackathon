import test from "node:test";
import assert from "node:assert/strict";
import { safeAudio } from "./ui.js";
import { feedList } from "./workspace.js";
import { api, ApiError } from "./api.js";

test("missing audio never creates a request to /null or /undefined", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://localhost:3000/" },
  });
  try {
    for (const value of [null, undefined, "", "   ", false])
      assert.equal(safeAudio(value), null);
    assert.equal(safeAudio("javascript:alert(1)"), null);
    assert.equal(
      safeAudio("/recording.mp3"),
      "http://localhost:3000/recording.mp3",
    );
    assert.equal(
      safeAudio("https://example.test/recording.mp3"),
      "https://example.test/recording.mp3",
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete globalThis.location;
  }
});
test("untrusted conversation identifiers and languages remain text in the feed", () => {
  const payload = '"><img src=x onerror=alert(1)>';
  const html = feedList({
    appeals: [],
    search: "",
    conversations: [
      {
        conversation_id: payload,
        language: "<script>alert(1)</script>",
        channel: "agent chat",
        status: null,
        message_count: 1,
        total: null,
      },
    ],
  });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});
test("API preserves server error details and encodes conversation IDs", async () => {
  const previous = globalThis.fetch;
  let address;
  globalThis.fetch = async (url) => {
    address = url;
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  };
  try {
    await assert.rejects(
      api.conversation("a/?x=1&y=2"),
      (error) =>
        error instanceof ApiError &&
        error.status === 404 &&
        error.message === "Conversation not found",
    );
    assert.equal(address, "/api/conversations/a%2F%3Fx%3D1%26y%3D2");
    globalThis.fetch = async () => {
      throw Error("network failure");
    };
    await assert.rejects(
      api.conversations(),
      (error) =>
        error instanceof ApiError &&
        error.status === 0 &&
        /Проверьте подключение/.test(error.message),
    );
  } finally {
    globalThis.fetch = previous;
  }
});
