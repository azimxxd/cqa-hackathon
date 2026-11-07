// Owner: Алдияр. Validation of model output against the CriterionResult contract (shared/schemas.md).
// normalize() turns a raw model item into a CriterionResult; validateResults() lists problems
// so evaluate.js can retry once with feedback, then fall back to safe defaults.

export function normalize(raw, criterion, conversation) {
  const ids = new Set((conversation.messages || []).map((m) => m.id));
  const fixId = (v) => {
    if (v == null) return null;
    const s = String(v).trim().replace(/^\[|\]$/g, '');
    if (ids.has(s)) return s;
    const n = s.match(/^m?(\d+)$/i);
    if (n) { const id = 'm' + n[1].padStart(3, '0'); if (ids.has(id)) return id; }
    return s; // keep for validation error
  };
  let answer = raw.answer == null || raw.answer === '' || raw.answer === 'null' ? null : String(raw.answer).toLowerCase();
  if (answer === 'n/a') answer = 'na';
  let scale_value = raw.scale_value == null || raw.scale_value === '' ? null : Number(raw.scale_value);
  if (criterion.type === 'binary') scale_value = null;
  if (criterion.type === 'scale' && answer !== 'na') answer = null;
  if (criterion.type === 'scale' && answer === 'na') scale_value = null;
  const evidence_ids = [...new Set((raw.evidence_ids || []).map(fixId).filter(Boolean))];
  const from = fixId(raw.checked_from ?? raw.checked_range?.from);
  const to = fixId(raw.checked_to ?? raw.checked_range?.to);
  return {
    criterion_id: criterion.id,
    answer,
    scale_value,
    explanation: String(raw.explanation ?? '').trim(),
    evidence_ids,
    checked_range: from || to ? { from: from || to, to: to || from } : null,
  };
}

/** Is this result "action missed"? (needs checked_range) */
export function isMissed(r, criterion) {
  if (criterion.gross_error) return false;
  if (criterion.type === 'binary') return r.answer === 'no';
  if (r.answer === 'na' || r.scale_value == null || !criterion.scale) return false;
  return r.scale_value < Math.max(...criterion.scale.map((s) => s.value));
}

export function validateResult(r, criterion, conversation) {
  const ids = new Set((conversation.messages || []).map((m) => m.id));
  const errs = [];
  if (criterion.type === 'binary') {
    if (!['yes', 'no', 'na'].includes(r.answer)) errs.push(`${criterion.id}: answer должен быть yes/no${criterion.na_allowed ? '/na' : ''}`);
  } else if (r.answer !== 'na') {
    const allowed = criterion.scale.map((s) => s.value);
    if (!allowed.includes(r.scale_value)) errs.push(`${criterion.id}: scale_value ${r.scale_value} не из шкалы [${allowed.join(', ')}]`);
  }
  if (r.answer === 'na' && !criterion.na_allowed) errs.push(`${criterion.id}: N/A недопустимо для этого критерия`);
  const bad = r.evidence_ids.filter((id) => !ids.has(id));
  if (bad.length) errs.push(`${criterion.id}: несуществующие evidence_ids ${bad.join(', ')}`);
  if (r.checked_range && (!ids.has(r.checked_range.from) || !ids.has(r.checked_range.to))) errs.push(`${criterion.id}: несуществующий checked_range`);
  if (criterion.type === 'binary' && r.answer === 'no' && !criterion.gross_error && !r.checked_range) errs.push(`${criterion.id}: для "no" нужен checked_from/checked_to`);
  return errs;
}

/** Clean up a result that still fails after retry so the pipeline never breaks. */
export function sanitize(r, criterion, conversation) {
  const msgs = conversation.messages || [];
  const ids = new Set(msgs.map((m) => m.id));
  const out = { ...r, evidence_ids: r.evidence_ids.filter((id) => ids.has(id)) };
  if (out.checked_range && (!ids.has(out.checked_range.from) || !ids.has(out.checked_range.to))) out.checked_range = null;
  if (out.answer === 'na' && !criterion.na_allowed) out.answer = criterion.type === 'binary' ? 'no' : null;
  if (criterion.type === 'binary' && !['yes', 'no', 'na'].includes(out.answer)) out.answer = criterion.gross_error ? 'no' : 'no';
  if (criterion.type === 'scale' && out.answer !== 'na') {
    const vals = criterion.scale.map((s) => s.value);
    if (!vals.includes(out.scale_value)) {
      const v = Number(out.scale_value);
      out.scale_value = Number.isFinite(v) ? vals.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : Math.min(...vals);
    }
  }
  if (isMissed(out, criterion) && !out.checked_range) {
    const ops = msgs.filter((m) => m.speaker === 'operator');
    const a = ops[0] || msgs[0], b = ops[ops.length - 1] || msgs[msgs.length - 1];
    if (a && b) out.checked_range = { from: a.id, to: b.id };
  }
  if (!out.explanation) out.explanation = 'Модель не дала объяснения; требуется ручная проверка.';
  return out;
}
