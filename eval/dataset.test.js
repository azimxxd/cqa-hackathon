import test from "node:test";
import assert from "node:assert/strict";
import { datasetRecords } from "./dataset.js";
test("eval accepts actual organizer envelope and previous local arrays before selecting conversations", () => {
  const records = [{ conversation_id: "DEV-a" }];
  assert.deepEqual(datasetRecords(records), records);
  assert.deepEqual(datasetRecords({ isSuccess: true, data: { records, total_records: 1 } }), records);
  for (const input of [{ isSuccess: false, data: { records } }, { isSuccess: true, data: { records, total_records: 2 } }, [...records, ...records], [{}]])
    assert.throws(() => datasetRecords(input));
});
