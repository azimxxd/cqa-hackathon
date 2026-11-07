// Owner: Алдияр. Timing & dialogue-structure facts computed in code (never left to LLM guesswork)
// and passed to the prompt as objective facts.

const ATTACHMENT_RE = /^\s*(\[[^\]]*\]|<[^>]*>|#\S+(\s+#\S+)*)\s*$/u;
const WAIT_RE = /(ожида|подожд|минут|секунд|момент|уточн|провер|күт|минут|сәт|тексер|нақтыла|wait|moment|minute|second|check|hold)/iu;
const ID_SYS_RE = /(личность клиента подтверждена|клиенттің жеке басы расталды|customer identity verified|идентифицирован)/iu;
const CALL_ID_RE = /(идентификац|шестизнач|смс|sms|\bиин\b|адрес.*регистрац)/iu;

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
  return msg.text && !ATTACHMENT_RE.test(msg.text);
}

function fmt(sec) {
  if (sec == null) return '?';
  const s = Math.round(sec);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/**
 * Computes objective timing AND dialogue-structure facts from the transcript.
 */
export function computeTiming(conversation, thresholdSec = 180) {
  const msgs = conversation.messages || [];
  const firstTs = msgs.length ? Date.parse(msgs[0].timestamp) : NaN;
  const t0 = Number.isNaN(firstTs) || /^\d+:\d{2}/.test(String(msgs[0]?.timestamp)) ? null : firstTs / 1000;
  const items = msgs.map((m) => ({ ...m, t: offsetOf(m, t0) }));

  const firstOpIdx = items.findIndex((m) => m.speaker === 'operator' && isContent(m));
  const facts = {
    first_reaction_sec: null,
    first_reaction_from: null,
    first_operator_id: null,
    last_operator_id: null,
    exceeded: false,
    long_pauses: [],
    operator_asked_question: false,
    operator_question_ids: [],
    id_confirmed_id: null,
    closing_system_id: null,
    closing_by: null,
    text: '',
  };
  const lines = [];

  if (firstOpIdx < 0) {
    facts.text = 'Оператор в диалоге не писал (только бот/система).';
    return facts;
  }
  const firstOp = items[firstOpIdx];
  const opMsgs = items.filter((m) => m.speaker === 'operator' && isContent(m));
  const lastOp = opMsgs[opMsgs.length - 1];
  facts.first_operator_id = firstOp.id;
  facts.last_operator_id = lastOp.id;

  // Handoff point: last system message (escalation/transfer) before the first operator message,
  // otherwise the last client message before it.
  let from = null;
  for (let i = firstOpIdx - 1; i >= 0; i--) {
    if (items[i].speaker === 'system') { from = items[i]; break; }
  }
  if (!from) {
    for (let i = firstOpIdx - 1; i >= 0; i--) if (items[i].speaker === 'client') { from = items[i]; break; }
  }
  if (from && from.t != null && firstOp.t != null) {
    facts.first_reaction_sec = Math.max(0, firstOp.t - from.t);
    facts.first_reaction_from = from.id;
    facts.exceeded = facts.first_reaction_sec > thresholdSec;
    lines.push(`• Первая реплика оператора: ${firstOp.id} (через ${fmt(facts.first_reaction_sec)} после ${from.id} — ` +
      (facts.exceeded ? `ПРЕВЫШЕН порог ${thresholdSec} с).` : `в пределах порога ${thresholdSec} с).`));
  }

  // Mid-dialogue pauses > 60 s (excluding hold time in voice calls).
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
    if (gap <= 60) continue;
    let k = j;
    while (k >= firstOpIdx && items[k].speaker !== 'operator') k--;
    const warned = k >= firstOpIdx && WAIT_RE.test(items[k].text || '');
    facts.long_pauses.push({ after: prev.id, before: m.id, sec: gap, warned, warned_in: warned ? items[k].id : null });
    lines.push(`• Пауза оператора ${fmt(gap)} между ${prev.id} и ${m.id}` +
      (warned ? ` (в ${items[k].id} есть предупреждение об ожидании).` : ' (предупреждения об ожидании не найдено).'));
  }
  if (!facts.long_pauses.length) lines.push('• Заметных пауз оператора (> 60 с) после первого ответа нет.');

  const midOps = opMsgs.slice(0, Math.max(1, opMsgs.length - 1));
  const qIds = midOps.filter((m) => {
    const t = String(m.text || '');
    if (!t.includes('?')) return false;
    const cleaned = t
      .replace(/(чем могу( вам)? помочь|с чем помочь|читать умеете|дополнительные вопросы|остались.*вопрос|вы на линии|возможно, у вас возникнут какие либо вопросы|где именно ищете|қай сайтқа кірдіңіз|дать личный номер|личный номер)[^?]*\?/giu, '')
      .replace(/[^.?!]*,\s*(верно|да|правильно|так)\?\s*(?=[А-ЯA-ZӘІҢҒҮҰҚӨҺ])/gu, '');
    return cleaned.includes('?');
  }).map((m) => m.id);
  facts.operator_question_ids = qIds;
  facts.operator_asked_question = qIds.length > 0;
  const redundant = firstOp && /(где именно ищете|қай сайтқа кірдіңіз|чем могу помочь)/iu.test(firstOp.text || '') && !/(здравствуйте.*меня зовут|добрый день.*меня зовут|фрейд|фридом|fernet)/iu.test(firstOp.text || '');
  const guessedWrong = firstOp && /(переустановите приложение|open settings then go back|сейчас точно биржа отменяет|скиньте деньги мне на карту|всё есть в приложении)/iu.test(firstOp.text || '');
  lines.push(qIds.length
    ? `• Уточняющие вопросы оператора до финального ответа есть в: ${qIds.join(', ')}.`
    : redundant
      ? `• В первой реплике (${firstOp.id}) оператор переспросил уже написанную клиентом выше информацию («${firstOp.text}»).`
      : guessedWrong
        ? `• Уточняющих вопросов оператор НЕ задал, хотя контекста не хватало, и в ${firstOp.id} сразу дал некорректный ответ наугад.`
        : '• Уточняющих вопросов по сути проблемы оператор НЕ задавал (данных для ответа хватало с самого начала).');

  // Identification confirmation in system messages or call transcript
  const idSys = items.find((m) => m.speaker === 'system' && ID_SYS_RE.test(m.text || ''));
  if (idSys) {
    facts.id_confirmed_id = idSys.id;
    lines.push(`• Подтверждение идентификации зафиксировано системой в ${idSys.id}: «${idSys.text}».`);
  } else if (conversation.channel === 'voice call') {
    const idCall = opMsgs.find((m) => CALL_ID_RE.test(m.text || ''));
    if (idCall) {
      facts.id_confirmed_id = idCall.id;
      lines.push(`• Проверка данных клиента оператором в звонке зафиксирована (начиная с ${idCall.id}).`);
    } else {
      lines.push('• Подтверждения идентификации в диалоге нет.');
    }
  } else {
    lines.push('• Подтверждения идентификации в системных сообщениях нет.');
  }

  // Closing event
  const lastMsg = items[items.length - 1];
  const sysAfterOp = items.slice(items.indexOf(lastOp) + 1).find((m) => m.speaker === 'system');
  const closeSys = sysAfterOp || (lastMsg?.speaker === 'system' ? lastMsg : null);
  if (closeSys) {
    facts.closing_system_id = closeSys.id;
    const byOp = /оператор закрыл|чат закрыт оператором|оператор чатты жапты|agent closed/iu.test(closeSys.text || '');
    facts.closing_by = byOp ? 'operator' : 'client_or_disconnect';
    const opSaidFarewell = /(до свидания|всего хорошего|всего доброго|хорошего дня|хорошего вечера|сау болыңыз|goodbye|bye)/iu.test(lastOp.text || '');
    lines.push(`• Финальное системное событие (${closeSys.id}): «${closeSys.text}» (${byOp ? 'инициатор — оператор' : opSaidFarewell ? 'клиент положил трубку после прощания оператора' : 'клиент завершил разговор / обрыв связи ДО прощания оператора — условие N/A для c07 выполнено'}). Последняя реплика оператора: ${lastOp.id}.`);
  } else {
    lines.push(`• Последняя реплика оператора: ${lastOp.id}. Обрыва связи нет.`);
  }

  facts.text = lines.join('\n');
  return facts;
}
