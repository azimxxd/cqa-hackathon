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

/** Official composition per dataset (organizer guide): checked right after import. */
export const EXPECTED_COMPOSITION = {
  DEV: { total: 65, channel: { "agent chat": 60, "voice call": 5 }, language: { RU: 35, KZ: 15, EN: 15 } },
  PROD: { total: 10, channel: { "agent chat": 10 } },
};

export function datasetComposition(records) {
  const out = { total: records.length, channel: {}, language: {} };
  for (const r of records) {
    out.channel[r.channel] = (out.channel[r.channel] || 0) + 1;
    out.language[r.language] = (out.language[r.language] || 0) + 1;
  }
  return out;
}

/** Returns human-readable warnings; empty array means the import looks official. */
export function compositionWarnings(records, dataset) {
  const expected = EXPECTED_COMPOSITION[String(dataset || "").toUpperCase()];
  if (!expected) return [];
  const actual = datasetComposition(records), warnings = [];
  if (actual.total !== expected.total) warnings.push(`total ${actual.total}, expected ${expected.total}`);
  for (const key of ["channel", "language"]) {
    if (!expected[key]) continue;
    const names = new Set([...Object.keys(expected[key]), ...Object.keys(actual[key])]);
    for (const name of names)
      if ((actual[key][name] || 0) !== (expected[key][name] || 0))
        warnings.push(`${key} ${name}: ${actual[key][name] || 0}, expected ${expected[key][name] || 0}`);
  }
  return warnings;
}
