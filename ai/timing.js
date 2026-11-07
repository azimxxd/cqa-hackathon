// Owner: Алдияр. Objective timing & structural facts computed in code and passed to the prompt.
// Never hardcodes DEV-specific phrases or pre-judges semantic criteria.

const ATTACHMENT_RE = /^\s*(\[[^\]]*\]|<[^>]*>|#\S+(\s+#\S+)*)\s*$/u;
const WAIT_RE = /(ожидай|подожд|минут[укы]?|секунд[уочкуы]?|одну минуту|один момент|оставайтесь на линии|(?:сейчас|щас)\s+(?:я\s+)?(?:проверю|уточню|посмотрю|узнаю)|күте тұр|күтіңіз|бір\s+(?:сәт|минут)|қазір\s+(?:мен\s+)?(?:тексер|нақтыла|қара)|please\s+wait|one\s+moment|just\s+a\s+(?:moment|second|minute)|hold\s+on|bear\s+with\s+me|(?:let\s+me|i(?:'ll|\s+will))\s+(?:check|look|verify))/iu;
const ID_SYS_RE = /(личность клиента подтверждена|клиенттің жеке басы расталды|customer identity verified|идентифицирован)/iu;
const CALL_ID_RE = /(идентификац|шестизнач|смс|sms|\bиин\b|адрес.*регистрац)/iu;
const CLOSE_SYS_RE = /(закрыл чат|чат закрыт|чатты жапты|closed the chat|покинул чат|соединение.*прервано|байланыс үзілді|connection.*lost|завершил разговор|ended the call|hung up)/iu;

/** Raw seconds parsed from timestamp (MM:SS, HH:MM:SS, or ISO 8601). */
export function parseTimestampSec(ts) {
  const s = String(ts ?? '').trim();
  if (!s) return null;
  const mmss = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (mmss) {
    return mmss[3] != null ? (+mmss[1]) * 3600 + (+mmss[2]) * 60 + (+mmss[3]) : (+mmss[1]) * 60 + (+mmss[2]);
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Seconds from start for a message; uses offset_sec when present, else parses timestamp relative to t0. */
export function offsetOf(msg, t0) {
  if (typeof msg?.offset_sec === 'number' && Number.isFinite(msg.offset_sec)) return msg.offset_sec;
  const raw = parseTimestampSec(msg?.timestamp);
  if (raw == null) return null;
  return t0 == null ? raw : Math.max(0, raw - t0);
}

export function resolveT0(msgs) {
  for (const m of msgs || []) {
    const s = String(m?.timestamp ?? '').trim();
    if (!s || /^\d+:\d{2}/.test(s)) continue;
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms / 1000;
  }
  return null;
}

function isContent(msg) {
  return Boolean(msg?.text && String(msg.text).trim() && !ATTACHMENT_RE.test(msg.text));
}

function fmt(sec) {
  if (sec == null) return '?';
  const s = Math.round(sec);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/**
 * Computes objective timing and structural metadata from the transcript.
 */
export function computeTiming(conversation, thresholdSec = 180) {
  const msgs = Array.isArray(conversation?.messages)
    ? conversation.messages
    : Array.isArray(conversation?.transcript)
      ? conversation.transcript.map((m, i) => ({ id: m.id || `m${String(i + 1).padStart(3, '0')}`, idx: i, ...m }))
      : [];
  const t0 = resolveT0(msgs);
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
    facts.text = 'Оператор в диалоге не отвечал (реплик speaker=operator с текстом нет): для всех критериев кроме gross_error ставь answer="na" (scale_value=null), а для gross_error (c08) ставь answer="no".';
    return facts;
  }
  const firstOp = items[firstOpIdx];
  const opMsgs = items.filter((m) => m.speaker === 'operator' && isContent(m));
  const lastOp = opMsgs[opMsgs.length - 1];
  facts.first_operator_id = firstOp.id;
  facts.last_operator_id = lastOp.id;

  // Handoff point: last system message (escalation/transfer/join) before the first operator message;
  // if no system message exists, take the first client message after the last bot turn.
  let from = null;
  for (let i = firstOpIdx - 1; i >= 0; i--) {
    if (items[i].speaker === 'system') { from = items[i]; break; }
  }
  if (!from) {
    let lastBotIdx = -1;
    for (let i = firstOpIdx - 1; i >= 0; i--) {
      if (items[i].speaker === 'bot') { lastBotIdx = i; break; }
    }
    for (let i = lastBotIdx + 1; i < firstOpIdx; i++) {
      if (items[i].speaker === 'client') { from = items[i]; break; }
    }
  }
  const hasIntro = conversation.channel === 'voice call'
    || /(меня зовут|Меня зовут|(?:^|[\s,!.])[Яя]\s+[А-ЯЁӘІҢҒҮҰҚӨҺ][а-яёәіңғүұқөһ]{2,}|(?:^|[\s,!.])[Мм]ен\s+[А-ЯЁӘІҢҒҮҰҚӨҺ][а-яёәіңғүұқөһ]{2,}|есімім|атым|\bI['’]m\s+[A-Z][a-z]+|\bI am\s+[A-Z][a-z]+|[Mm]y name is\s+[A-Z][a-z]+|\[Имя скрыто\])/u.test(firstOp.text || '');
  const introNote = hasIntro ? '' : ' ВНИМАНИЕ для c01: в первой реплике оператор НЕ представился по имени (c01 → answer="no")!';
  if (from && from.t != null && firstOp.t != null) {
    facts.first_reaction_sec = Math.max(0, firstOp.t - from.t);
    facts.first_reaction_from = from.id;
    facts.exceeded = facts.first_reaction_sec > thresholdSec;
    lines.push(`• Первая реплика оператора: ${firstOp.id} (через ${fmt(facts.first_reaction_sec)} после ${from.id} — ` +
      (facts.exceeded ? `ПРЕВЫШЕН порог первой реакции ${thresholdSec} с!).` : `в пределах порога ${thresholdSec} с).`) + introNote);
  } else {
    lines.push(`• Первая реплика оператора: ${firstOp.id}.${introNote}`);
  }

  // Mid-dialogue pauses > 60 s (excluding hold intervals in voice calls).
  let onHold = false;
  for (let i = firstOpIdx + 1; i < items.length; i++) {
    const m = items[i];
    if (m.speaker === 'system') {
      if (/находится на удержании|on hold/i.test(m.text || '')) onHold = true;
      if (/больше не находится на удержании|off hold/i.test(m.text || '')) onHold = false;
      continue;
    }
    if (onHold || m.speaker !== 'operator' || !isContent(m) || m.t == null) continue;
    let j = i - 1;
    while (j >= firstOpIdx && !(
      (items[j].speaker === 'system' && items[j].t != null) ||
      (['client', 'operator'].includes(items[j].speaker) && isContent(items[j]))
    )) j--;
    const prev = items[j];
    if (!prev || prev.t == null) continue;
    const gap = m.t - prev.t;
    if (gap <= 60) continue;

    let warned = false;
    let warnedIn = null;
    if (prev.speaker === 'operator' && WAIT_RE.test(prev.text || '')) {
      warned = true;
      warnedIn = prev.id;
    } else if (prev.speaker === 'client' && !String(prev.text || '').includes('?') && String(prev.text || '').length < 60) {
      let k = j - 1;
      while (k >= firstOpIdx && items[k].speaker !== 'operator') k--;
      if (k >= firstOpIdx && WAIT_RE.test(items[k].text || '')) {
        warned = true;
        warnedIn = items[k].id;
      }
    }
    facts.long_pauses.push({ after: prev.id, before: m.id, sec: gap, warned, warned_in: warnedIn });
    lines.push(`• Пауза оператора ${fmt(gap)} между ${prev.id} и ${m.id}` +
      (warned ? ` (оператор предупредил об ожидании в ${warnedIn}).` : ' (БЕЗ предупреждения об ожидании!).'));
  }
  if (!facts.long_pauses.length) lines.push('• Заметных пауз оператора (> 60 с) после первого ответа нет.');

  // Clarifying questions by operator (distinguishing substantive c02 clarification from c03 ID questions or boilerplate)
  const ID_Q_RE = /(фио|фамили|имя|аты-жөн|full name|телефон|номер|phone|иин|жсн|iin|код|sms|смс|адрес|address|проживан|туған|рождени|birth|email|почт|жеке дерек|personal data|идентиф|верифик)/iu;
  const TOPIC_Q_RE = /(приложен|сайт|кабинет|тикер|бумаг|эмитент|облигац|валют|ошибк|раздел|документ|отчёт|отчет|сообщен|приказ|поручен|перевод|комисс|платформ|қосымша|қате|тапсырма|акци|app|website|currency|ticker|error|document|order)/iu;
  const IMPERATIVE_CLARIFY_RE = /(назовите|уточните|подскажите|укажите)[^.?!]*(тикер|бумаг|эмитент|код бумаг|раздел|ошибк|валют|способ)/iu;
  const midOps = opMsgs.slice(0, Math.max(1, opMsgs.length - 1));
  const qIds = midOps.filter((m) => {
    const t = String(m.text || '');
    if (IMPERATIVE_CLARIFY_RE.test(t)) return true;
    if (!t.includes('?')) return false;
    const cleaned = t
      .replace(/(чем могу( вам)? помочь|с чем помочь|как я могу к вам обращаться|дополнительные вопросы|остались.*вопрос|вы на линии|читать умеете)[^?]*\?/giu, '')
      .replace(/[^.?!]*,\s*(верно|да|правильно|так)\?\s*(?=$|[А-ЯA-ZӘІҢҒҮҰҚӨҺ])/gu, '');
    if (!cleaned.includes('?')) return false;
    if (ID_Q_RE.test(cleaned) && !TOPIC_Q_RE.test(cleaned)) return false;
    return true;
  }).map((m) => m.id);
  facts.operator_question_ids = qIds;
  facts.operator_asked_question = qIds.length > 0;
  const firstOpText = String(firstOp.text || '');
  const clientAskedBeforeOp = items.slice(0, firstOpIdx).some((m) => m.speaker === 'client' && String(m.text || '').length > 15);
  const genericHelpOnly = conversation.channel !== 'voice call' && clientAskedBeforeOp && /(чем могу( вам)? помочь|с чем помочь)\?/iu.test(firstOpText) && firstOpText.length < 70;
  lines.push(genericHelpOnly
    ? `• Внимание для c02: в первой реплике ${firstOp.id} оператор задал шаблонный вопрос «Чем могу помочь?», проигнорировав уже написанный выше вопрос клиента (это нарушение c02 → answer="no").`
    : qIds.length
      ? `• Уточняющие реплики оператора по сути обращения (для c02): ${qIds.join(', ')}.`
      : '• Уточняющих вопросов оператора по сути проблемы (помимо приветствия/идентификации) не зафиксировано: если запрос клиента изначально был понятен и самодостаточен, для c02 ставь answer="na"; если же запрос был неполным и оператор гадал вслепую — answer="no".');

  // Identification confirmation in system messages or voice call transcript
  const idSys = items.find((m) => m.speaker === 'system' && ID_SYS_RE.test(m.text || ''));
  if (idSys) {
    facts.id_confirmed_id = idSys.id;
    lines.push(`• Подтверждение идентификации в системном событии ${idSys.id}: «${idSys.text}».`);
  } else if (conversation.channel === 'voice call') {
    const idCall = opMsgs.find((m) => CALL_ID_RE.test(m.text || ''));
    if (idCall) {
      facts.id_confirmed_id = idCall.id;
      lines.push(`• Проверка идентификационных данных клиента в звонке зафиксирована (начиная с ${idCall.id}).`);
    } else {
      lines.push('• Формальной идентификации с проверкой ИИН/адреса и SMS-кода в звонке не проводилось — консультация по общим правилам/навигации (для c03 ставь answer="na").');
    }
  } else {
    lines.push('• Системного сообщения о подтверждении идентификации в чате нет.');
  }

  // Closing / disconnect system event (checks trailing messages too, since ASR call transcripts can flush 1 turn after hangup)
  const tailStart = Math.max(0, items.indexOf(lastOp) - 2);
  const closeSys = [...items.slice(tailStart)].reverse().find((m) => m.speaker === 'system' && CLOSE_SYS_RE.test(m.text || ''))
    || (items[items.length - 1]?.speaker === 'system' ? items[items.length - 1] : null);
  if (closeSys) {
    facts.closing_system_id = closeSys.id;
    const byOp = /оператор закрыл|чат закрыт оператором|оператор чатты жапты|agent closed/iu.test(closeSys.text || '');
    facts.closing_by = byOp ? 'operator' : 'client_or_disconnect';
    const opSaidFarewell = /(до свидания|всего хорошего|всего доброго|хорошего дня|хорошего вечера|сау болыңыз|күніңіз сәтті|goodbye|bye|take care|have a good day)/iu.test(lastOp.text || '');
    lines.push(`• Финальное системное событие (${closeSys.id}): «${closeSys.text}» (${byOp ? 'инициатор закрытия — оператор' : opSaidFarewell ? 'клиент завершил разговор после прощания оператора' : 'обрыв связи / клиент завершил разговор ДО прощания оператора'}). Последняя реплика оператора: ${lastOp.id}.`);
  } else {
    lines.push(`• Последняя реплика оператора: ${lastOp.id}. Системного события обрыва связи нет.`);
  }

  facts.text = lines.join('\n');
  return facts;
}
