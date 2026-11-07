import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Deny all external I/O even when a regression tries loading DEV before validating options.
const preload =
  "data:text/javascript," +
  encodeURIComponent(
    'globalThis.fetch = async () => { throw new Error("NETWORK_BLOCKED_IN_TEST"); };',
  );
function run(args, environment = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      fileURLToPath(new URL("./run.js", import.meta.url)),
      ...args,
      "--group",
      `config-check-${randomUUID()}`,
    ],
    {
      env: {
        ...process.env,
        ORG_API_URL: "https://organizer.stub.test",
        GEMINI_API_KEY: "stub",
        LLM_CONCURRENCY: "6",
        ...environment,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
}
for (const option of ["concurrency", "limit"]) {
  test(`eval rejects invalid ${option} before fetching any data`, () => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "9007199254740992",
      "",
    ]) {
      const result = run([`--${option}=${value}`]);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(`Invalid eval ${option}: expected a positive safe integer`),
      );
      assert.doesNotMatch(result.stderr, /NETWORK_BLOCKED_IN_TEST/);
    }
  });
}
test("eval validates concurrency from the environment before fetching data", () => {
  const result = run([], { LLM_CONCURRENCY: "0" });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid eval concurrency/);
  assert.doesNotMatch(result.stderr, /NETWORK_BLOCKED_IN_TEST/);
});
test("valid CLI concurrency overrides an invalid environment setting", () => {
  const result = run(["--concurrency", "2", "--limit", "1"], {
    LLM_CONCURRENCY: "0",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NETWORK_BLOCKED_IN_TEST/);
  assert.doesNotMatch(result.stderr, /Invalid eval/);
});
