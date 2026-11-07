// Owner: Алдияр. Validation and post-processing of model output against the CriterionResult contract
// (shared/schemas.md). Enforces strict binary/scale invariants, valid message IDs, and checked_range rules.

export function isMissed(r, criterion) {
  if (!r || !criterion || criterion.gross_error) return false;
  if (criterion.type === 'binary') return r.answer === 'no';
  if (r.answer === 'na' || r.scale_value == null || !Array.isArray(criterion.scale) || !criterion.scale.length) return false;
  return r.scale_value < Math.max(...criterion.scale.map((s) => s.value));
}

function defaultRange(criterion, msgs) {
  if (!msgs || !msgs.length) return null;
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const firstOp = ops[0] || msgs[0];
  const lastOp = ops[ops.length - 1] || msgs[msgs.length - 1];
  const lastMsg = msgs[msgs.length - 1];
  if (criterion.id === 'c01') return { from: firstOp.id, to: firstOp.id };
  if (criterion.id === 'c07') return { from: lastOp.id, to: lastMsg.id };
  return { from: firstOp.id, to: lastOp.id };
}

function defaultEvidence(r, criterion, msgs) {
  if (!msgs || !msgs.length) return [];
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const clients = msgs.filter((m) => m.speaker === 'client');
  const firstOp = ops[0];
  const lastOp = ops[ops.length - 1];
  const lastMsg = msgs[msgs.length - 1];

  const valid = new Set(msgs.map((m) => m.id));
  const inText = [...String(r.explanation || '').matchAll(/\bm(\d{1,3})\b/gi)]
    .map((m) => 'm' + m[1].padStart(3, '0'))
    .filter((id) => valid.has(id));
  if (inText.length) return [...new Set(inText)];
  if (criterion.gross_error && r.answer === 'no') return [];
  if (criterion.id === 'c01') return firstOp ? [firstOp.id] : [msgs[0].id];
  if (criterion.id === 'c07') return lastMsg?.speaker === 'system' ? [lastMsg.id] : lastOp ? [lastOp.id] : [lastMsg.id];
  if (r.answer === 'na') return clients[0] ? [clients[0].id] : [msgs[0].id];
  return firstOp ? [firstOp.id] : [lastMsg.id];
}

export function normalize(raw, criterion, conversation) {
  const msgs = conversation?.messages || [];
  const hasOperator = msgs.some((m) => m.speaker === 'operator');
  const naAllowed = Boolean(criterion.na_allowed || (!hasOperator && !criterion.gross_error));
  const ids = new Set(msgs.map((m) => m.id));
  const idxOf = new Map(msgs.map((m, i) => [m.id, i]));
  const fixId = (v) => {
    if (v == null || typeof v === 'boolean') return null;
    const s = String(v).trim().replace(/^\[|\]$/g, '');
    if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') return null;
    if (ids.has(s)) return s;
    const n = s.match(/^m?(\d+)$/i);
    if (n) {
      const id = 'm' + n[1].padStart(3, '0');
      if (ids.has(id)) return id;
    }
    return s; // preserve invalid ID so validateResult triggers retry
  };

  let answer = null;
  if (raw?.answer != null && typeof raw.answer !== 'boolean') {
    const a = String(raw.answer).trim().toLowerCase();
    if (a !== '' && a !== 'null' && a !== 'none') answer = a === 'n/a' ? 'na' : a;
  }

  let scale_value = null;
  if (raw?.scale_value != null && typeof raw.scale_value !== 'boolean') {
    const sv = String(raw.scale_value).trim();
    if (sv !== '' && !['null', 'na', 'n/a', 'none'].includes(sv.toLowerCase())) {
      const n = Number(sv);
      scale_value = Number.isFinite(n) ? n : sv;
    }
  }

  if (criterion.type === 'binary') {
    scale_value = null;
  } else if (criterion.type === 'scale') {
    const allowed = (criterion.scale || []).map((s) => s.value);
    if (answer === 'na' && naAllowed) {
      if (scale_value == null) {
        scale_value = null;
      } else if (allowed.includes(scale_value) && scale_value > 0) {
        answer = null;
      } else if (scale_value === 0) {
        const exp = `${raw?.explanation || ''} ${raw?.reasoning || ''}`;
        const isTrueNa = !hasOperator || /(закончился до|прервался до|покинул.*до|не успел.*вопрос|до формулировки|нет оператора|не подключился|ended before|before asking|сұрақ қоймай|сұрақ қойылмады)/iu.test(exp);
        if (isTrueNa) scale_value = null;
        else answer = null;
      }
    } else if (answer !== 'na') {
      answer = null;
    }
  }

  const evidence_ids = [...new Set((Array.isArray(raw?.evidence_ids) ? raw.evidence_ids : []).map(fixId).filter(Boolean))];
  const from = fixId(raw?.checked_from ?? raw?.checked_range?.from);
  const to = fixId(raw?.checked_to ?? raw?.checked_range?.to);

  const r = {
    criterion_id: criterion.id,
    answer,
    scale_value,
    explanation: String(raw?.explanation ?? '').trim(),
    evidence_ids,
    checked_range: null,
  };

  if (isMissed(r, criterion)) {
    if (from || to) {
      let a = from || to;
      let b = to || from;
      if (idxOf.has(a) && idxOf.has(b) && idxOf.get(a) > idxOf.get(b)) [a, b] = [b, a];
      r.checked_range = { from: a, to: b };
    }
  }
  if (!r.evidence_ids.length) r.evidence_ids = defaultEvidence(r, criterion, msgs);
  return r;
}

export function validateResult(r, criterion, conversation) {
  const msgs = conversation?.messages || [];
  const hasOperator = msgs.some((m) => m.speaker === 'operator');
  const naAllowed = Boolean(criterion.na_allowed || (!hasOperator && !criterion.gross_error));
  const ids = new Set(msgs.map((m) => m.id));
  const errs = [];

  if (criterion.type === 'binary') {
    if (!['yes', 'no', 'na'].includes(r.answer)) {
      errs.push(`${criterion.id}: answer должен быть yes/no${naAllowed ? '/na' : ''}`);
    }
    if (r.scale_value !== null) {
      errs.push(`${criterion.id}: для binary критерия scale_value должен быть null`);
    }
  } else if (criterion.type === 'scale') {
    if (r.answer !== null && r.answer !== 'na') {
      errs.push(`${criterion.id}: для scale критерия answer должен быть null или na`);
    }
    if (r.answer === 'na') {
      if (r.scale_value !== null) errs.push(`${criterion.id}: при answer="na" поле scale_value должно быть null`);
    } else {
      const allowed = (criterion.scale || []).map((s) => s.value);
      if (!allowed.includes(r.scale_value)) {
        errs.push(`${criterion.id}: scale_value ${r.scale_value} не из шкалы [${allowed.join(', ')}]`);
      }
    }
  }

  if (r.answer === 'na' && !naAllowed) {
    errs.push(`${criterion.id}: N/A недопустимо для этого критерия`);
  }

  const bad = (r.evidence_ids || []).filter((id) => !ids.has(id));
  if (bad.length) errs.push(`${criterion.id}: несуществующие evidence_ids ${bad.join(', ')}`);

  if (r.checked_range && (!ids.has(r.checked_range.from) || !ids.has(r.checked_range.to))) {
    errs.push(`${criterion.id}: несуществующий checked_range`);
  }
  if (criterion.type === 'binary' && r.answer === 'no' && !criterion.gross_error && msgs.length > 0 && !r.checked_range) {
    errs.push(`${criterion.id}: для "no" нужен checked_from/checked_to`);
  }
  return errs;
}

/** Clean up a result so the output strictly conforms to CriterionResult in shared/schemas.md. */
export function sanitize(r, criterion, conversation) {
  const msgs = conversation?.messages || [];
  const hasOperator = msgs.some((m) => m.speaker === 'operator');
  const naAllowed = Boolean(criterion.na_allowed || (!hasOperator && !criterion.gross_error));
  const ids = new Set(msgs.map((m) => m.id));
  const idxOf = new Map(msgs.map((m, i) => [m.id, i]));

  let answer = r?.answer ?? null;
  let scale_value = r?.scale_value ?? null;

  if (!hasOperator && !criterion.gross_error) {
    answer = 'na';
    scale_value = null;
  } else if (answer === 'na' && !naAllowed) {
    answer = criterion.type === 'binary' ? 'no' : null;
  }

  if (criterion.type === 'binary') {
    scale_value = null;
    if (!['yes', 'no', 'na'].includes(answer)) answer = 'no';
  } else if (criterion.type === 'scale') {
    if (answer !== 'na') answer = null;
    if (answer === 'na') {
      scale_value = null;
    } else {
      const vals = (criterion.scale || []).map((s) => s.value);
      if (!vals.includes(scale_value)) {
        const v = typeof scale_value === 'boolean' || scale_value == null || String(scale_value).trim() === '' ? NaN : Number(scale_value);
        scale_value = Number.isFinite(v) && vals.length
          ? vals.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
          : (vals.length ? Math.min(...vals) : 0);
      }
    }
  }

  let checked_range = r?.checked_range && ids.has(r.checked_range.from) && ids.has(r.checked_range.to)
    ? { from: r.checked_range.from, to: r.checked_range.to }
    : null;
  if (checked_range && idxOf.get(checked_range.from) > idxOf.get(checked_range.to)) {
    checked_range = { from: checked_range.to, to: checked_range.from };
  }

  const out = {
    criterion_id: criterion.id,
    answer,
    scale_value,
    explanation: String(r?.explanation ?? '').trim(),
    evidence_ids: [...new Set((Array.isArray(r?.evidence_ids) ? r.evidence_ids : []).filter((id) => ids.has(id)))],
    checked_range: null,
  };

  if (isMissed(out, criterion)) {
    out.checked_range = checked_range || defaultRange(criterion, msgs);
  } else {
    out.checked_range = null;
  }

  if (!out.evidence_ids.length) out.evidence_ids = defaultEvidence(out, criterion, msgs);
  if (!out.explanation) out.explanation = 'Модель не дала объяснения; требуется ручная проверка.';
  return out;
}
