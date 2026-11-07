// Owner: Алдияр. Validation and post-processing of model output against the CriterionResult contract
// (shared/schemas.md). Ensures zero hallucinated IDs, non-empty evidence where applicable, and clean
// checked_range semantics (null when fulfilled/N/A; exact expected range when missed).

export function isMissed(r, criterion) {
  if (criterion.gross_error) return false;
  if (criterion.type === 'binary') return r.answer === 'no';
  if (r.answer === 'na' || r.scale_value == null || !criterion.scale) return false;
  return r.scale_value < Math.max(...criterion.scale.map((s) => s.value));
}

function defaultRange(criterion, msgs) {
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const firstOp = ops[0] || msgs[0];
  const lastOp = ops[ops.length - 1] || msgs[msgs.length - 1];
  const lastMsg = msgs[msgs.length - 1];
  if (!firstOp || !lastMsg) return null;
  if (criterion.id === 'c01') return { from: firstOp.id, to: firstOp.id };
  if (criterion.id === 'c07') return { from: lastOp.id, to: lastMsg.id };
  return { from: firstOp.id, to: lastOp.id };
}

function defaultEvidence(r, criterion, msgs) {
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const clients = msgs.filter((m) => m.speaker === 'client');
  const firstOp = ops[0];
  const lastOp = ops[ops.length - 1];
  const lastMsg = msgs[msgs.length - 1];
  // Extract any mNNN mentioned in the explanation text first
  const valid = new Set(msgs.map((m) => m.id));
  const inText = [...String(r.explanation || '').matchAll(/\bm(\d{1,3})\b/gi)]
    .map((m) => 'm' + m[1].padStart(3, '0'))
    .filter((id) => valid.has(id));
  if (inText.length) return [...new Set(inText)];
  if (criterion.gross_error && r.answer === 'no') return [];
  if (criterion.id === 'c01' && firstOp) return [firstOp.id];
  if (criterion.id === 'c07') return lastMsg?.speaker === 'system' ? [lastMsg.id] : lastOp ? [lastOp.id] : [];
  if (r.answer === 'na') return clients[0] ? [clients[0].id] : msgs[0] ? [msgs[0].id] : [];
  return firstOp ? [firstOp.id] : [];
}

export function normalize(raw, criterion, conversation) {
  const msgs = conversation.messages || [];
  const ids = new Set(msgs.map((m) => m.id));
  const idxOf = new Map(msgs.map((m, i) => [m.id, i]));
  const fixId = (v) => {
    if (v == null || v === '' || v === 'null') return null;
    const s = String(v).trim().replace(/^\[|\]$/g, '');
    if (ids.has(s)) return s;
    const n = s.match(/^m?(\d+)$/i);
    if (n) { const id = 'm' + n[1].padStart(3, '0'); if (ids.has(id)) return id; }
    return s; // keep invalid id so validateResult triggers retry
  };

  let answer = raw.answer == null || raw.answer === '' || raw.answer === 'null' ? null : String(raw.answer).toLowerCase();
  if (answer === 'n/a') answer = 'na';
  let scale_value = raw.scale_value == null || raw.scale_value === '' ? null : Number(raw.scale_value);
  if (criterion.type === 'binary') scale_value = null;
  if (criterion.type === 'scale') {
    const allowed = (criterion.scale || []).map((s) => s.value);
    if (allowed.includes(scale_value) && (scale_value > 0 || !/закончился до|не успел сформулировать|до формулировки/i.test(raw.explanation || ''))) {
      answer = null;
    } else if (answer === 'na') {
      const hasQuestion = msgs.some((m) => m.speaker === 'client' && (m.text || '').length > 45);
      if (hasQuestion) { answer = null; scale_value = Math.max(...allowed); }
      else scale_value = null;
    } else {
      answer = null;
    }
  }

  let evidence_ids = [...new Set((raw.evidence_ids || []).map(fixId).filter(Boolean))];
  const from = fixId(raw.checked_from ?? raw.checked_range?.from);
  const to = fixId(raw.checked_to ?? raw.checked_range?.to);

  const r = {
    criterion_id: criterion.id,
    answer,
    scale_value,
    explanation: String(raw.explanation ?? '').trim(),
    evidence_ids,
    checked_range: null,
  };

  // Keep checked_range ONLY when an action was missed (so UI doesn't highlight "missed" on a 100% pass).
  if (isMissed(r, criterion)) {
    if (from || to) {
      let a = from || to, b = to || from;
      if (idxOf.has(a) && idxOf.has(b) && idxOf.get(a) > idxOf.get(b)) [a, b] = [b, a];
      r.checked_range = { from: a, to: b };
    }
  }
  if (!r.evidence_ids.length) r.evidence_ids = defaultEvidence(r, criterion, msgs);
  return r;
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
  if (criterion.type === 'binary' && !['yes', 'no', 'na'].includes(out.answer)) out.answer = 'no';
  if (criterion.type === 'scale' && out.answer !== 'na') {
    const vals = criterion.scale.map((s) => s.value);
    if (!vals.includes(out.scale_value)) {
      const v = Number(out.scale_value);
      out.scale_value = Number.isFinite(v) ? vals.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : Math.min(...vals);
    }
  }
  if (isMissed(out, criterion)) {
    if (!out.checked_range) out.checked_range = defaultRange(criterion, msgs);
  } else {
    out.checked_range = null;
  }
  if (!out.evidence_ids.length) out.evidence_ids = defaultEvidence(out, criterion, msgs);
  if (!out.explanation) out.explanation = 'Модель не дала объяснения; требуется ручная проверка.';
  return out;
}
