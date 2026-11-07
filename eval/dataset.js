/** Normalize local arrays and the official API envelope before any model call. */
export function datasetRecords(input) {
  const records = Array.isArray(input) ? input : input?.isSuccess === true ? input.data?.records : null;
  if (!Array.isArray(records)) throw Error("Dataset must be a records array or successful organizer envelope");
  if (!Array.isArray(input) && input.data.total_records !== undefined && input.data.total_records !== records.length)
    throw Error("Dataset record count mismatch");
  if (records.some(r => typeof r?.conversation_id !== "string" || !r.conversation_id.trim()) ||
      new Set(records.map(r => r.conversation_id)).size !== records.length)
    throw Error("Dataset conversation IDs must be nonempty and unique");
  return records;
}
