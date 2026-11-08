import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submissionChecklist } from "../scripts/control-config.js";
import {
  openDatabase,
  getChecklist,
  saveChecklist,
  criterionHash,
} from "./db.js";
test("database seeds immutable checklist versions and semantic hashes", () => {
  const db = openDatabase(":memory:");
  try {
    const first = getChecklist(db);
    assert.equal(first.criteria.length, 8);
    const changed = structuredClone(first);
    changed.criteria[0].weight = 99;
    changed.criteria[0].na_allowed = true;
    const second = saveChecklist(db, changed);
    assert.notEqual(first.id, second.id);
    assert.equal(first.criteria[0].hash, second.criteria[0].hash);
    assert.equal(getChecklist(db, first.id).criteria[0].weight, 10);
    assert.notEqual(
      criterionHash({ ...first.criteria[0], title: "new" }),
      first.criteria[0].hash,
    );
  } finally {
    db.close();
  }
});

test("criterion hashes separate field boundaries and agree with AI hash semantics", async () => {
  const { criterionHash: aiHash } = await import("../ai/evaluate.js");
  const c = {
    id: "custom",
    title: "T",
    type: "binary",
    description: "AB",
    na_condition: "C",
    scale: null,
  };
  const other = { ...c, description: "A", na_condition: "BC" };
  assert.notEqual(criterionHash(c), criterionHash(other));
  for (const value of [
    c,
    other,
    { ...c, weight: 99, na_allowed: true, gross_error: true },
    { ...c, na_condition: undefined },
  ])
    assert.equal(criterionHash(value), aiHash(value));
});

test("derived hashes of historical checklist versions follow current formula", () => {
  const db = openDatabase(":memory:");
  try {
    const version = getChecklist(db);
    version.criteria[0].hash = "legacy-hash";
    db.prepare("UPDATE checklist_versions SET data=? WHERE id=1").run(
      JSON.stringify(version),
    );
    assert.equal(
      getChecklist(db, 1).criteria[0].hash,
      criterionHash(version.criteria[0]),
    );
  } finally {
    db.close();
  }
});

test("upgrading the official checklist preserves old versions and seeds the correction once", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cqa-checklist-upgrade-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "app.db");
  let db = openDatabase(filename);
  const legacy = getChecklist(db, 1);
  legacy.criteria[5].description = legacy.criteria[5].description.replace(
    "Порог первой реакции в 3 минуты,",
    "Порог первой реакции — 3 минуты;",
  );
  db.prepare("UPDATE checklist_versions SET data=? WHERE id=1").run(JSON.stringify(legacy));
  const custom = saveChecklist(db, { ...legacy, name: "Правила жюри" });
  db.close();

  db = openDatabase(filename);
  try {
    assert.equal(getChecklist(db, 1).criteria[5].description, legacy.criteria[5].description);
    assert.equal(getChecklist(db, custom.id).name, "Правила жюри");
    const official = submissionChecklist(db);
    assert.equal(official.id, 3);
    assert.match(official.criteria[5].description, /Порог первой реакции в 3 минуты,/);
  } finally {
    db.close();
  }
  db = openDatabase(filename);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM checklist_versions").get().count, 3);
  } finally {
    db.close();
  }
});
