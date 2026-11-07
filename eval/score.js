// Share scoring and rounding with the server so the metric matches the UI.
import { scoreEvaluation } from "../server/scoring.js";
export function totalScore(results, criteria) {
  return scoreEvaluation(
    { criteria },
    {
      criteria: criteria.map((c) => {
        const result = results.find((r) => r.criterion_id === c.id);
        return { criterion_id: c.id, original: result, final: result };
      }),
    },
  ).total;
}
export function grossError(results, criteria) {
  return criteria.some(
    (c) =>
      c.gross_error &&
      results.find((r) => r.criterion_id === c.id)?.answer === "yes",
  );
}
export function labelOf(r, c) {
  if (!r) return undefined;
  if (r.answer === "na") return "na";
  return c.type === "scale" ? r.scale_value : r.answer;
}
