// Normalize wire format without inventing answers; validation errors drive one feedback retry.
export function normalize(raw, criterion, conversation) {
  const ids = new Set((conversation.messages || []).map((m) => m.id));
  const fixId = (v) => {
    if (v == null) return null;
    const s = String(v)
      .trim()
      .replace(/^\[|\]$/g, "");
    if (ids.has(s)) return s;
    const n = s.match(/^m?(\d+)$/i);
    if (n) {
      const id = "m" + n[1].padStart(3, "0");
      if (ids.has(id)) return id;
    }
    return s;
  };
  let answer =
    raw.answer == null || raw.answer === "" || raw.answer === "null"
      ? null
      : String(raw.answer).toLowerCase();
  if (answer === "n/a") answer = "na";
  const evidence = Array.isArray(raw.evidence_ids)
    ? raw.evidence_ids
    : typeof raw.evidence_ids === "string"
      ? [raw.evidence_ids]
      : [];
  const from = fixId(raw.checked_from ?? raw.checked_range?.from);
  const to = fixId(raw.checked_to ?? raw.checked_range?.to);
  const scale = raw.scale_value;
  return {
    criterion_id: raw.criterion_id,
    answer,
    scale_value:
      scale == null || (typeof scale === "string" && scale.trim() === "")
        ? null
        : typeof scale === "number" || typeof scale === "string"
          ? Number(scale)
          : NaN,
    explanation: raw.explanation,
    evidence_ids: [...new Set(evidence.map(fixId).filter(Boolean))],
    checked_range: from || to ? { from, to } : null,
  };
}
export function validateResult(r, criterion, conversation) {
  const errs = [];
  const bad = (text) => errs.push(`${criterion.id}: ${text}`);
  if (!r || typeof r !== "object") return [`${criterion.id}: нет результата`];
  if (r.criterion_id !== criterion.id) bad("неверный criterion_id");
  if (typeof r.explanation !== "string") bad("explanation должна быть строкой");
  if (r.answer === "na") {
    if (!criterion.na_allowed) bad("N/A недопустимо для этого критерия");
    if (r.scale_value != null) bad("N/A не допускает scale_value");
  } else if (criterion.type === "binary") {
    if (!["yes", "no"].includes(r.answer) || r.scale_value != null)
      bad("answer должен быть yes/no, scale_value=null");
  } else if (criterion.type === "scale") {
    const allowed = (criterion.scale || []).map((s) => s.value);
    if (
      r.answer != null ||
      !allowed.includes(r.scale_value) ||
      Math.max(...allowed) <= 0
    )
      bad(
        `scale_value ${r.scale_value} не из шкалы [${allowed.join(", ")}] или answer не null`,
      );
  } else bad("неверный тип критерия");
  const messages = conversation.messages || [];
  const ids = new Set(messages.map((m) => m.id));
  if (
    !Array.isArray(r.evidence_ids) ||
    r.evidence_ids.some((id) => typeof id !== "string" || !ids.has(id))
  )
    bad(
      `несуществующие или неверные evidence_ids ${JSON.stringify(r.evidence_ids)}`,
    );
  if (
    r.checked_range != null &&
    (typeof r.checked_range !== "object" || Array.isArray(r.checked_range))
  )
    bad("checked_range должен быть объектом или null");
  else if (r.checked_range) {
    const { from, to } = r.checked_range;
    if (!ids.has(from) || !ids.has(to)) bad("несуществующий checked_range");
    else if (
      messages.findIndex((m) => m.id === from) >
      messages.findIndex((m) => m.id === to)
    )
      bad("checked_range: from должен предшествовать to");
  }
  if (r.answer === "no" && !criterion.gross_error && !r.checked_range)
    bad('для "no" нужен checked_from/checked_to');
  return errs;
}
// Optional evidence cleanup only. Never changes a model's answer, scale or checked range.
export function sanitize(r, criterion, conversation) {
  const ids = new Set((conversation.messages || []).map((m) => m.id));
  return {
    ...r,
    evidence_ids: (Array.isArray(r.evidence_ids) ? r.evidence_ids : []).filter(
      (id) => ids.has(id),
    ),
  };
}
