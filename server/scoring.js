export const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export function scoreCriterion(criterion, result) {
  if (!Number.isFinite(criterion.weight) || criterion.weight < 0)
    throw new Error("Invalid weight");
  if (!result) throw new Error(`Missing result for ${criterion.id}`);
  if (result.answer === "na") {
    if (!criterion.na_allowed)
      throw new Error(`N/A forbidden for ${criterion.id}`);
    if (result.scale_value != null)
      throw new Error("N/A cannot have scale_value");
    return { weight: 0, points: 0 };
  }
  let ratio;
  if (criterion.type === "binary") {
    if (!["yes", "no"].includes(result.answer) || result.scale_value != null)
      throw new Error(`Invalid binary answer for ${criterion.id}`);
    ratio = result.answer === "yes" ? 1 : 0;
  } else if (criterion.type === "scale") {
    const values = (criterion.scale ?? []).map((s) => s.value);
    if (
      result.answer != null ||
      !values.includes(result.scale_value) ||
      Math.max(...values) <= 0
    )
      throw new Error(`Invalid scale answer for ${criterion.id}`);
    ratio = result.scale_value / Math.max(...values);
  } else throw new Error("Invalid criterion type");
  const weight =
    criterion.scores_points === false || criterion.gross_error
      ? 0
      : criterion.weight;
  return { weight, points: weight * ratio };
}
export function validateResult(criterion, result, conversation) {
  scoreCriterion(criterion, result);
  const ids = new Set(conversation.messages.map((m) => m.id));
  if (
    result.criterion_id !== criterion.id ||
    typeof result.explanation !== "string" ||
    !Array.isArray(result.evidence_ids) ||
    result.evidence_ids.some((id) => typeof id !== "string" || !ids.has(id))
  )
    throw new Error("Invalid criterion result or evidence");
  const range = result.checked_range;
  if (result.answer === "no" && !criterion.gross_error && !range)
    throw new Error("checked_range required for no");
  if (
    range != null &&
    (typeof range !== "object" || Array.isArray(range) || !ids.has(range.from) ||
      !ids.has(range.to) ||
      conversation.messages.findIndex((m) => m.id === range.from) >
        conversation.messages.findIndex((m) => m.id === range.to))
  )
    throw new Error("Invalid checked_range");
  return result;
}
export function scoreEvaluation(checklist, evaluation) {
  const calculate = (field) => {
    const entries = checklist.criteria.map((c) => {
      const row = evaluation.criteria.find((r) => r.criterion_id === c.id);
      if (!row) throw new Error(`Missing criterion ${c.id}`);
      return { c, row, ...scoreCriterion(c, row[field]) };
    });
    const denominator = entries.reduce((sum, e) => sum + e.weight, 0);
    const multiplier = denominator ? 100 / denominator : 0;
    const sections = new Map();
    for (const e of entries) {
      if (e.c.scores_points === false || e.c.gross_error) continue;
      const section = sections.get(e.c.section) ?? { points: 0, max: 0 };
      sections.set(e.c.section, section);
      section.points += e.points * multiplier;
      section.max += e.weight * multiplier;
    }
    for (const section of sections.values()) {
      section.points = round(section.points);
      section.max = round(section.max);
    }
    return {
      total: denominator
        ? round(entries.reduce((s, e) => s + e.points, 0) * multiplier)
        : null,
      sections: Object.fromEntries(sections),
      entries,
      multiplier,
    };
  };
  const final = calculate("final");
  return {
    ...evaluation,
    criteria: final.entries.map((e) => ({
      ...e.row,
      weight: e.c.weight,
      effective_weight: round(e.weight * final.multiplier),
      points: round(e.points * final.multiplier),
    })),
    sections: final.sections,
    total: final.total,
    original_total: calculate("original").total,
    gross_error: final.entries.some(
      (e) => e.c.gross_error && e.row.final.answer === "yes",
    ),
  };
}
