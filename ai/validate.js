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
  if (typeof r.explanation !== "string" || !r.explanation.trim())
    bad("explanation должна содержать непустое обоснование");
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
  else if (
    !(criterion.gross_error && r.answer === "no") &&
    r.evidence_ids.length === 0 &&
    !(r.answer === "no" && r.checked_range)
  )
    bad("нужно конкретное evidence; checked_range допустим только для пропущенного действия (no)");
  if (
    r.checked_range != null &&
    (typeof r.checked_range !== "object" || Array.isArray(r.checked_range))
  )
    bad("checked_range должен быть объектом или null");
  else if (r.checked_range) {
    const { from, to } = r.checked_range;
    if (!ids.has(from) || !ids.has(to)) bad(`несуществующий checked_range ${JSON.stringify({ from, to })}; допустимые ID: ${[...ids].join(", ")}`);
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

// B2: code-side anti-hallucination. Never changes the answer — only returns review flags.
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s) => norm(s).split(" ").filter((w) => w.length > 1);
const script = (s) => (/[а-яёәғқңөұүһі]/i.test(s) ? "cyr" : /[a-z]/i.test(s) ? "lat" : "other");

/** Quotes in «…», "…" or “…” from explanation; at least 3 words to be worth checking. */
export function extractQuotes(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/«([^»]{3,300})»|“([^”]{3,300})”|"([^"]{3,300})"/g)) {
    const q = (m[1] ?? m[2] ?? m[3]).trim();
    if (words(q).length >= 3) out.push(q);
  }
  return out;
}

/** Share of the quote's words found, in order-independent form, inside a message. */
function coverage(quote, text) {
  const have = new Set(words(text));
  const need = words(quote);
  return need.length ? need.filter((w) => have.has(w) || [...have].some((h) => h.length > 4 && w.startsWith(h.slice(0, 5)))).length / need.length : 1;
}

function verifiable(q, language, messages) {
  const lang = String(language || "").toUpperCase();
  if (lang === "EN") return script(q) === "lat";
  if (lang === "KZ") return /[әғқңөұүһі]/i.test(q);
  return messages.some((m) => script(m.text) === script(q));
}

export function quoteFlags(r, conversation) {
  const flags = [];
  const messages = conversation.messages || [];
  const ids = new Set(messages.map((m) => m.id));
  for (const id of String(r.explanation ?? "").match(/\bm\d{3}\b/g) || [])
    if (!ids.has(id)) flags.push(`explanation ссылается на несуществующую реплику ${id}`);
  const referenced = new Set(r.evidence_ids || []);
  const from = messages.findIndex(m => m.id === r.checked_range?.from);
  const to = messages.findIndex(m => m.id === r.checked_range?.to);
  if (from >= 0 && to >= from) for (const m of messages.slice(from, to + 1)) referenced.add(m.id);
  const evidence = messages.filter(m => referenced.has(m.id));
  const explanation = String(r.explanation ?? "");
  let cursor = 0;
  for (const q of extractQuotes(explanation)) {
    const position = explanation.indexOf(q, cursor);
    const prefix = explanation.slice(Math.max(cursor, position - 180), position);
    cursor = position + q.length;
    if (!verifiable(q, conversation.language, messages)) continue;
    const matches = m => norm(m.text).includes(norm(q)) || coverage(q, m.text) >= 0.8;
    const cited = evidence.filter(matches);
    if (!cited.length) {
      flags.push(messages.some(matches)
        ? `цитата есть в диалоге, но отсутствует в указанных доказательствах: «${q.slice(0, 80)}»`
        : `цитата не найдена в репликах: «${q.slice(0, 80)}»`);
      continue;
    }
    // Check explicit attribution only; quotations may legitimately describe the client.
    const roles = [...prefix.matchAll(/(?<!\p{L})(?:оператор|клиент|бот|agent|operator|customer|client|bot)(?!\p{L})/giu)];
    const last = roles.at(-1)?.[0].toLowerCase();
    const role = !last ? null : /^(оператор|agent|operator)/.test(last) ? "operator" : /^(клиент|customer|client)/.test(last) ? "client" : "bot";
    if (role && cited.every(m => m.speaker && m.speaker !== role))
      flags.push(`автор цитаты не совпадает с указанной ролью ${role}: «${q.slice(0, 80)}»`);
  }
  return [...new Set(flags)];
}
