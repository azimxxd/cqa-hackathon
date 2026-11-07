// Owner: Алдияр. Scoring used by the eval harness (mirrors the official rules / server/scoring.js):
// yes = full weight, no = 0, scale = value / max * weight, N/A excluded and weight redistributed,
// criteria with scores_points=false (gross error) excluded; no applicable weight -> null.

export function totalScore(results, criteria, rounding = 2) {
  let pts = 0, w = 0;
  for (const c of criteria) {
    if (c.scores_points === false || !c.weight) continue;
    const r = results.find((x) => x.criterion_id === c.id);
    if (!r || r.answer === 'na') continue;
    w += c.weight;
    if (c.type === 'scale') pts += ((r.scale_value ?? 0) / Math.max(...c.scale.map((s) => s.value))) * c.weight;
    else if (r.answer === 'yes') pts += c.weight;
  }
  if (!w) return null;
  return +((pts / w) * 100).toFixed(rounding);
}

export function grossError(results, criteria) {
  return criteria.some((c) => c.gross_error && results.find((r) => r.criterion_id === c.id)?.answer === 'yes');
}

/** Comparable label for a result: "yes"/"no"/"na" or the scale number. */
export function labelOf(r, c) {
  if (!r) return undefined;
  if (r.answer === 'na') return 'na';
  return c.type === 'scale' ? r.scale_value : r.answer;
}
