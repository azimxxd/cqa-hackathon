// Owner: Алдияр. Timing facts computed in code (not by the LLM) and passed to the prompt as facts:
// first operator reaction vs threshold, long operator pauses and whether a wait was announced.
// Tags and attachments are ignored (official rule for c06).

const ATTACHMENT_RE = /^\s*(\[[^\]]*\]|<[^>]*>|#\S+(\s+#\S+)*)\s*$/u;
const WAIT_RE = /(подождите|ожидайте|прошу\s+ожидать|одну\s+минуту|минуту[,]?\s+пожалуйста|сейчас\s+(проверю|уточню|посмотрю)|күте\s+тұрыңыз|бір\s+(минут|сәт)|one\s+moment|please\s+(hold|wait)|let\s+me\s+check)/iu;
const HANDOFF_RE = /(перевед[её]н.*оператор|перевод.*оператор|эскалаци|передан.*оператор|transfer.*(agent|operator)|escalat|операторға.*(ауыстыр|беріл))/iu;
export const LONG_PAUSE_THRESHOLD_SEC = 60;

/** Seconds from start for a message; uses offset_sec when present, else parses timestamp. */
export function offsetOf(msg, t0) {
  if (typeof msg.offset_sec === 'number') return msg.offset_sec;
  const ts = String(msg.timestamp ?? '');
  const mmss = ts.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (mmss) {
    return mmss[3] != null ? (+mmss[1]) * 3600 + (+mmss[2]) * 60 + (+mmss[3]) : (+mmss[1]) * 60 + (+mmss[2]);
  }
  const ms = Date.parse(ts);
  if (!Number.isNaN(ms)) return t0 == null ? ms / 1000 : ms / 1000 - t0;
  return null;
}

function isContent(msg) {
  return msg.text && !ATTACHMENT_RE.test(msg.text) && !/^\s*(тег|tag|вложение|attachment)\s*:/iu.test(msg.text);
}

function fmt(sec) {
  if (sec == null) return '?';
  const s = Math.round(sec);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/**
 * @returns {{first_reaction_sec:number|null, first_reaction_from:string|null, first_operator_id:string|null,
 *   exceeded:boolean, long_pauses:{after:string, before:string, sec:number, warned:boolean}[], text:string}}
 */
export function computeTiming(conversation, thresholdSec = 180) {
  const msgs = conversation.messages || [];
  const firstTs = msgs.length ? Date.parse(msgs[0].timestamp) : NaN;
  const t0 = Number.isNaN(firstTs) || /^\d+:\d{2}/.test(String(msgs[0]?.timestamp)) ? null : firstTs / 1000;
  const items = msgs.map((m) => ({ ...m, t: offsetOf(m, t0) }));

  const firstOpIdx = items.findIndex((m) => m.speaker === 'operator' && isContent(m));
  const facts = { first_reaction_sec: null, first_reaction_from: null, first_operator_id: null, exceeded: false, long_pauses: [], text: '' };
  const lines = [];

  if (firstOpIdx < 0) {
    facts.text = 'Оператор в диалоге не писал (только бот/система).';
    return facts;
  }
  const firstOp = items[firstOpIdx];
  facts.first_operator_id = firstOp.id;

  // Handoff point: last system message (escalation/transfer) before the first operator message,
  // otherwise the last client message before it.
  let from = null;
  for (let i = firstOpIdx - 1; i >= 0; i--) {
    if (items[i].speaker === 'system' && isContent(items[i]) && HANDOFF_RE.test(items[i].text)) { from = items[i]; break; }
  }
  if (!from) {
    for (let i = firstOpIdx - 1; i >= 0; i--) if (items[i].speaker === 'client' && isContent(items[i])) { from = items[i]; break; }
  }
  if (from && from.t != null && firstOp.t != null) {
    facts.first_reaction_sec = Math.max(0, firstOp.t - from.t);
    facts.first_reaction_from = from.id;
    facts.exceeded = facts.first_reaction_sec > thresholdSec;
    lines.push(`Первая реакция оператора (${firstOp.id}) через ${fmt(facts.first_reaction_sec)} после ${from.id} — ` +
      (facts.exceeded ? `ПРЕВЫШЕН порог ${thresholdSec} с.` : `в пределах порога ${thresholdSec} с.`));
  }

  // Mid-dialogue pauses > 60 s between the previous turn (or operator's wait promise) and the next operator reply.
  let onHold = false;
  for (let i = firstOpIdx + 1; i < items.length; i++) {
    const m = items[i];
    if (m.speaker === 'system') {
      if (/находится на удержании|on hold/i.test(m.text)) onHold = true;
      if (/больше не находится на удержании|off hold/i.test(m.text)) onHold = false;
      continue;
    }
    if (onHold || m.speaker !== 'operator' || !isContent(m) || m.t == null) continue;
    let j = i - 1;
    while (j >= firstOpIdx && !(['client', 'operator'].includes(items[j].speaker) && isContent(items[j]))) j--;
    const prev = items[j];
    if (!prev || prev.t == null) continue;
    const gap = m.t - prev.t;
    if (gap <= LONG_PAUSE_THRESHOLD_SEC) continue;
    let k = j;
    while (k >= firstOpIdx && items[k].speaker !== 'operator') k--;
    const warned = k >= firstOpIdx && WAIT_RE.test(items[k].text || '');
    facts.long_pauses.push({ after: prev.id, before: m.id, sec: gap, warned, warned_in: warned ? items[k].id : null });
    lines.push(`Пауза оператора ${fmt(gap)} между ${prev.id} и ${m.id}` +
      (warned ? ` (перед паузой в ${items[k].id} есть предупреждение об ожидании).` : ' (предупреждения об ожидании не найдено).'));
  }
  if (!facts.long_pauses.length) lines.push(`Заметных пауз оператора (> ${LONG_PAUSE_THRESHOLD_SEC} с) после первого ответа нет.`);
  facts.text = lines.join('\n');
  return facts;
}
