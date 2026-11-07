import { audioUrl } from "./api.js";
import { escape as e, icon, button, emptyState, skeleton, statusBadge, score, time } from "./ui.js";
import { checklistPage, scorecard, versionSelect } from "./views.js";

export function datasetRows(s) {
  return s.datasetIds
    ? s.conversations.filter((c) => s.datasetIds.has(c.conversation_id))
    : s.conversations;
}

export function feedRows(s) {
  const disputed = new Set(s.appeals.filter((a) => a.status === "open").map((a) => a.conversation_id));
  return datasetRows(s).filter((c) =>
    c.conversation_id.toLowerCase().includes(s.search.trim().toLowerCase()) &&
    (s.filter !== "voice" || c.channel === "voice call") &&
    (s.filter !== "errors" || c.gross_error || c.status === "error") &&
    (s.filter !== "appeals" || disputed.has(c.conversation_id)));
}

export function feedList(s) {
  const rows = feedRows(s);
  if (!s.conversations.length && !s.loading && !s.error)
    return emptyState("Диалогов пока нет", "Импортируйте группу организаторов.", button("Импортировать","import","upload-simple"));
  if (s.loading && !s.conversations.length) return skeleton();
  if (!rows.length)
    return emptyState("Диалоги не найдены", "Измените фильтры или выберите другую выборку.",
      button("Сбросить фильтры", "reset-filters", "arrow-clockwise"));
  return `<ul class="cqa-feed-list">${rows.map((c) => {
    const selected = s.selected === c.conversation_id;
    return `<li><a href="#dialog/${e(encodeURIComponent(c.conversation_id))}" class="cqa-feed-item ${selected ? "is-active" : ""}" ${selected ? 'aria-current="true"' : ""}><span class="title-4">${e(c.conversation_id)}</span><strong class="title-4">${score(c.total)}</strong><span class="caption-5">${icon(c.channel === "voice call" ? "phone" : "chat-circle-text")}${c.channel === "voice call" ? "Звонок" : "Чат"} · ${e(c.language || "—")}</span>${statusBadge(c.status)}</a></li>`;
  }).join("")}</ul>`;
}

function feed(s) {
  return `<aside class="cqa-feed" aria-label="Лента диалогов"><div class="cqa-feed-controls">
    <h2 class="title-3">Диалоги <span class="cqa-count caption-4">${datasetRows(s).length}</span></h2>
    <label class="cqa-search">${icon("magnifying-glass")}<input id="dialog-search" type="search" placeholder="Поиск по ID" aria-label="Поиск по ID диалога" value="${e(s.search)}"></label>
    <div class="cqa-studio-actions" role="group" aria-label="Фильтры ленты">${[["all","Все"],["errors","Ошибки"],["voice","Звонки"],["appeals","Споры"]].map(([id,label]) =>
      `<button class="cqa-studio-chip caption-3" data-filter="${id}" aria-pressed="${s.filter === id}">${label}</button>`).join("")}</div>
    <div class="cqa-studio-actions">${versionSelect(s)}${button("Оценить выборку","evaluate-all","play",true,s.job || !datasetRows(s).length || !s.version || !s.ai?.configured ? "disabled" : "")}</div>
    <p id="dispute-warning" class="caption-5" role="status" ${s.filter === "appeals" && s.disputesIncomplete ? "" : "hidden"}>Не удалось проверить часть апелляций.</p>
    <div id="feed-job">${jobProgress(s.job)}</div>
    </div><div class="cqa-feed-scroll" id="dialog-feed">${feedList(s)}</div></aside>`;
}

export function jobProgress(job) {
  if (!job) return "";
  return `<div class="cqa-job" role="status"><progress aria-label="Оценка диалогов" value="${e(job.done || 0)}" max="${e(job.total || 1)}"></progress><span class="caption-3">${e(job.done || 0)} / ${e(job.total || 0)}</span></div>`;
}

export function transcriptControls(s) {
  const t = s.transcription;
  const pending = t?.status === "running" || t?.status === "loading";
  const ready = t?.status === "done";
  const model = t?.model || s.ai?.transcription_model;
  return `<div class="cqa-studio-actions" role="group" aria-label="Текст звонка">
    <button class="cqa-studio-chip caption-3" data-transcript="original" aria-pressed="${s.textMode !== "gemini"}">Исходный</button>
    <button class="cqa-studio-chip caption-3" data-transcript="gemini" aria-pressed="${s.textMode === "gemini"}" ${ready ? "" : "disabled"}>Gemini</button>
    ${ready ? "" : button(pending ? "Расшифровка выполняется" : "Расшифровать Gemini", "transcribe", "file-text", true, pending || !s.ai?.transcription_configured ? "disabled" : "")}
    </div><p class="caption-5 cqa-muted" role="status">${e(model || "Модель Gemini недоступна")}${ready ? " · Авторасшифровка: проверьте текст и привязку по записи" : ""}${pending ? " · Ожидаем результат" : s.ai?.transcription_configured === false && !ready ? " · Расшифровка не настроена" : ""}</p>
    ${t?.error ? `<p class="cqa-form-error caption-2" role="alert">${e(t.error)}</p>` : ""}`;
}

const speakers = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };
export function transcriptMessages(conversation, transcription, mode) {
  const voice = conversation.channel === "voice call";
  const aligned = new Map(mode === "gemini" && transcription?.status === "done"
    ? transcription.messages.map((m) => [m.id, m.text]) : []);
  return conversation.messages.length ? conversation.messages.map((m) =>
    `<article class="cqa-message cqa-speaker-${Object.hasOwn(speakers,m.speaker) ? m.speaker : "system"}" id="message-${e(m.id)}" data-message="${e(m.id)}" tabindex="-1">
    <div class="cqa-message-meta caption-5"><span>${e(Object.hasOwn(speakers,m.speaker) ? speakers[m.speaker] : m.speaker)}</span><span>${e(m.id)} · ${voice ? `<button class="cqa-text-button caption-5" data-evidence="${e(m.id)}" aria-label="Перемотать к ${e(time(m.offset_sec))}">${e(time(m.offset_sec))}</button>` : e(time(m.offset_sec))}</span></div>
    <p class="body-6">${e(m.speaker === "system" ? m.text : aligned.get(m.id) ?? m.text)}</p></article>`).join("") :
    emptyState("Нет сообщений", "В этом диалоге пока нет реплик.");
}

function stream(s) {
  if (s.loading) return skeleton();
  if (s.error) return emptyState("Не удалось загрузить диалог", s.error, button("Попробовать снова","refresh","arrow-clockwise"));
  if (!s.detail) return emptyState("Выберите диалог", "Откройте звонок или чат из ленты.");
  const { conversation: c } = s.detail;
  const voice = c.channel === "voice call";
  const rows = feedRows(s);
  const index = rows.findIndex((row) => row.conversation_id === s.selected);
  return `<header class="cqa-stream-heading"><div><h1 id="page-title" tabindex="-1" class="heading-6">${e(c.conversation_id)}</h1>
    <p class="caption-2 cqa-muted">${voice ? "Звонок" : "Чат"} · ${e(c.language || "Язык не указан")}</p></div>
    <div class="cqa-studio-actions">${[-1,1].map((delta) =>
      `<button type="button" class="cqa-icon-button" data-adjacent="${delta}" ${index < 0 || !rows[index + delta] ? "disabled" : ""} aria-label="${delta < 0 ? "Предыдущий диалог" : "Следующий диалог"}">${icon(delta < 0 ? "arrow-left" : "arrow-right")}</button>`).join("")}</div></header>
    ${voice ? `<div class="cqa-audio"><audio id="conversation-audio" controls preload="metadata" aria-label="Запись разговора" src="${e(audioUrl(c.conversation_id))}"></audio>
    <p id="audio-error" role="status" class="caption-2 cqa-form-error" hidden>Не удалось загрузить запись звонка.</p>
    <label class="caption-2">Скорость <select id="audio-speed">${[0.75,1,1.25,1.5,2].map((n) => `<option value="${n}" ${n === 1 ? "selected" : ""}>${n}×</option>`).join("")}</select></label>
    <div id="transcript-controls">${transcriptControls(s)}</div></div>` : ""}
    <div id="transcript-messages" class="cqa-messages" tabindex="0" aria-label="Сообщения диалога">${transcriptMessages(c,s.transcription,s.textMode)}</div>`;
}

export function auditContents(s) {
  if (s.drawer) return `<div class="cqa-drawer-actions">${button("Закрыть редактор","checklist-drawer","x")}</div>${
    s.drawerError ? emptyState("Не удалось загрузить чек-лист", s.drawerError) :
    s.checklist ? checklistPage(s, true) : skeleton()}`;
  if (s.loading) return skeleton();
  return s.detail && !s.error ? scorecard(s) : emptyState("Оценка диалога", "Выберите диалог, чтобы увидеть оценку.");
}

export function workspacePage(s) {
  return `<div class="cqa-studio">${feed(s)}
    <section class="cqa-stream" aria-label="Диалог">${stream(s)}</section>
    <aside class="cqa-audit" aria-label="${s.drawer ? "Редактор чек-листа" : "Оценка диалога"}">${auditContents(s)}</aside></div>`;
}
