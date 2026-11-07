import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.js";
import { saveConversations, getConversation } from "./import.js";
import { createJobService } from "./jobs.js";
import { getEvaluation } from "./evaluations.js";
test("queued jobs resume after reopening SQLite; completed results and call logs persist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cqa-persistence-")),
    path = join(dir, "cqa.db");
  let db = openDatabase(path),
    service = createJobService(db, { fake: true });
  try {
    const conversation = JSON.parse(
      readFileSync(
        new URL("../shared/mocks/conversation.json", import.meta.url),
      ),
    );
    saveConversations(db, [conversation], "DEV");
    const { job_id } = service.submit({
      conversation_ids: "all",
      checklist_version_id: 1,
    });
    await service.close();
    db.close();
    db = openDatabase(path);
    service = createJobService(db, { fake: true });
    for (
      let i = 0;
      i < 100 && !["done", "error"].includes(service.get(job_id).status);
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(service.get(job_id).status, "done");
    assert.equal(getEvaluation(db, 1).total, 100);
    await service.close();
    db.close();
    db = openDatabase(path);
    service = createJobService(db, { fake: true });
    assert.equal(service.get(job_id).status, "done");
    assert.equal(getEvaluation(db, 1).model, "fake");
    assert.equal(
      getEvaluation(db, 1).criteria[0].final.explanation.startsWith("FAKE"),
      true,
    );
    assert.deepEqual(
      getConversation(db, conversation.conversation_id),
      conversation,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_calls").get().n, 1);
  } finally {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
