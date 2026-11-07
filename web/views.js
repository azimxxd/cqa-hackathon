import {
  escape as e,
  icon,
  number,
  score,
  money,
  messageCount,
  formatDate,
  time,
  statusBadge,
  emptyState,
  button,
  safeAudio,
} from "./ui.js";

export function pageHeader(title, description, actions = "") {
  return `<div class="cqa-page-heading"><div><p class="caption-2 cqa-muted">Контроль качества</p><h1 class="heading-4" tabindex="-1" id="page-title">${e(title)}</h1><p class="body-6 cqa-muted">${e(description)}</p></div><div class="cqa-heading-actions">${actions}</div></div>`;
}
export function versionSelect(s, id = "version-select", value = s.version) {
  return `<label class="cqa-version caption-2">Чек-лист <select id="${id}" aria-label="Версия чек-листа">${s.versions.map((v) => `<option value="${v.id}" ${v.id === Number(value) ? "selected" : ""}>Версия ${v.id}</option>`).join("")}</select></label>`;
}
function metric(label, value, detail = "", extra = "") {
  return `<div class="cqa-metric ${extra}"><p class="caption-2 cqa-muted">${e(label)}</p><p class="heading-4 cqa-numeric">${e(value)}</p>${detail ? `<p class="caption-5 cqa-muted">${e(detail)}</p>` : ""}</div>`;
}
export function dialogsPage(s) {
  const done = s.conversations.filter((c) => c.status === "done");
  const scored = done.filter((c) => c.total != null);
  const average = scored.length
    ? score(scored.reduce((n, c) => n + c.total, 0) / scored.length)
    : "—";
  return `${pageHeader("Диалоги", "От первого ответа до финального решения.", button("Импортировать", "import", "upload-simple") + button(s.job ? "Оценка выполняется" : "Оценить диалоги", "evaluate-all", "play", true, s.job || !s.conversations.length || !s.version ? "disabled" : ""))}
    <section class="cqa-summary" aria-label="Сводка по диалогам">${metric("Всего диалогов", number(s.conversations.length), "В рабочем пространстве")}${metric("Оценено", number(done.length), s.conversations.length ? `${Math.round((done.length / s.conversations.length) * 100)}% от всех диалогов` : "Пока нет данных")}${metric("Средняя оценка", average, "Из 100 возможных баллов", "cqa-metric-accent")}${metric("Грубые ошибки", number(done.filter((c) => c.gross_error).length), "В последних оценках")}</section>
    ${s.job ? `<div class="cqa-job" role="status">${icon("clock")}<span class="body-6">Оцениваем диалоги</span><progress value="${s.job.done || 0}" max="${s.job.total || 1}"></progress><span class="caption-3">${s.job.done || 0} / ${s.job.total || s.conversations.length}</span></div>` : ""}
    <section class="cqa-panel cqa-dialog-list"><div class="cqa-panel-heading"><div><h2 class="title-3">Все диалоги <span class="cqa-count caption-4">${s.conversations.length}</span></h2><p class="caption-2 cqa-muted">Последние результаты оценки</p></div>${versionSelect(s)}</div>
    <div class="cqa-filters"><label class="cqa-search">${icon("magnifying-glass")}<input id="dialog-search" type="search" placeholder="Найти по ID диалога" aria-label="Поиск по ID диалога" value="${e(s.search)}"><kbd class="caption-5">/</kbd></label><select id="channel-filter" aria-label="Канал"><option value="">Все каналы</option><option value="agent chat" ${s.channel === "agent chat" ? "selected" : ""}>Чаты</option><option value="voice call" ${s.channel === "voice call" ? "selected" : ""}>Звонки</option></select><select id="status-filter" aria-label="Статус оценки"><option value="">Все статусы</option>${[
      ["done", "Оценены"],
      ["empty", "Не оценены"],
      ["error", "С ошибкой"],
      ["running", "В работе"],
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}" ${s.status === v ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></div><div id="dialog-table">${dialogTable(s)}</div></section>
    <p class="cqa-footnote caption-5">${icon("list-checks")}Оценки сохраняют исходный ответ модели и решение проверяющего.</p>`;
}
export function dialogTable(s) {
  if (!s.conversations.length)
    return emptyState(
      "Начнём с первого диалога",
      "Импортируйте группу диалогов, чтобы оценить работу операторов.",
      button("Импортировать диалоги", "import", "plus", true),
    );
  const rows = s.conversations.filter(
    (c) =>
      (!s.search ||
        c.conversation_id.toLowerCase().includes(s.search.toLowerCase())) &&
      (!s.channel || c.channel === s.channel) &&
      (!s.status ||
        (s.status === "empty"
          ? !c.status
          : s.status === "running"
            ? ["running", "queued"].includes(c.status)
            : c.status === s.status)),
  );
  if (!rows.length)
    return emptyState(
      "Диалоги не найдены",
      "Попробуйте другой ID или сбросьте фильтры.",
      button("Сбросить фильтры", "reset-filters", "arrow-clockwise"),
    );
  return `<div class="cqa-table-wrap"><table class="cqa-table"><thead><tr><th scope="col">Диалог</th><th scope="col">Канал и язык</th><th scope="col">Статус</th><th scope="col" class="cqa-align-right">Оценка</th><th scope="col"><span class="cqa-sr-only">Открыть</span></th></tr></thead><tbody>${rows.map((c) => `<tr data-dialog="${e(c.conversation_id)}"><td><button class="cqa-row-link title-4" data-open="${e(c.conversation_id)}">${e(c.conversation_id)}</button><p class="caption-5 cqa-muted">${messageCount(c.message_count || 0)}<span class="cqa-mobile-meta"> · ${c.channel === "voice call" ? "Звонок" : "Чат"} · ${e(c.language || "—")}</span></p></td><td><span class="cqa-channel body-6">${icon(c.channel === "voice call" ? "phone" : "chat-circle-text")}${c.channel === "voice call" ? "Звонок" : "Чат"}<span class="cqa-language caption-5">${e(c.language || "—")}</span></span></td><td>${statusBadge(c.status)}${c.gross_error ? '<span class="cqa-gross-label caption-5">Есть грубая ошибка</span>' : ""}</td><td class="cqa-align-right"><span class="cqa-score ${c.total != null ? (c.total >= 80 ? "cqa-score-good" : c.total >= 60 ? "cqa-score-medium" : "cqa-score-low") : ""} title-3">${score(c.total)}</span>${c.total != null ? '<span class="cqa-score-max caption-5"> / 100</span>' : ""}</td><td>${icon("arrow-up-right", "cqa-row-arrow")}</td></tr>`).join("")}</tbody></table></div><div class="cqa-table-footer caption-5 cqa-muted"><span>Показано ${number(rows.length)} из ${number(s.conversations.length)}</span><span>Нажмите на диалог, чтобы открыть оценку</span></div>`;
}
export function transcript(conversation) {
  const speakers = {
    client: "Клиент",
    operator: "Оператор",
    bot: "Бот",
    system: "Система",
  };
  const audio = safeAudio(conversation.audio_url);
  return `<section class="cqa-panel cqa-transcript"><div class="cqa-panel-heading"><div><h2 class="title-3">Транскрипт</h2><p class="caption-2 cqa-muted">${messageCount(conversation.messages.length)} · ${e(conversation.language || "Язык не указан")}</p></div><span class="cqa-channel caption-2">${icon(conversation.channel === "voice call" ? "phone" : "chat-circle-text")}${conversation.channel === "voice call" ? "Звонок" : "Чат"}</span></div>${conversation.channel === "voice call" && audio ? `<div class="cqa-audio"><audio id="conversation-audio" controls preload="metadata" aria-label="Запись разговора" src="${e(audio)}"></audio></div>` : ""}<div class="cqa-messages" id="transcript-messages" tabindex="0" aria-label="Сообщения диалога">${conversation.messages.length ? conversation.messages.map((m) => `<article class="cqa-message cqa-speaker-${["client", "operator", "bot", "system"].includes(m.speaker) ? m.speaker : "system"}" id="message-${e(m.id)}" data-message="${e(m.id)}" tabindex="-1"><div class="cqa-message-meta caption-5"><span>${e(speakers[m.speaker] || m.speaker)}</span><span>${e(m.id)} · ${time(m.offset_sec)}</span></div><p class="body-6">${e(m.text)}</p></article>`).join("") : emptyState("Нет сообщений", "В этом диалоге пока нет реплик.")}</div></section>`;
}
function resultLabel(c, r) {
  if (r.answer === "na") return "Не применимо";
  if (c.type === "scale")
    return `${r.scale_value} / ${Math.max(...c.scale.map((v) => v.value))}`;
  return r.answer === "yes" ? "Да" : "Нет";
}
export function detailPage(s) {
  const { conversation: c, evaluation: ev, checklist } = s.detail;
  const assessed = ev?.status === "done";
  const actions = button(
    s.job ? "Оценка выполняется" : assessed ? "Переоценить" : "Оценить диалог",
    "evaluate-one",
    "play",
    true,
    s.job ? "disabled" : "",
  );
  const failed = assessed
    ? ev.criteria.filter((row) => {
        const crit = checklist.criteria.find((c) => c.id === row.criterion_id);
        return crit?.gross_error
          ? row.final.answer === "yes"
          : row.final.answer === "no" ||
              (crit?.type === "scale" &&
                row.final.answer !== "na" &&
                row.final.scale_value <
                  Math.max(...crit.scale.map((s) => s.value)));
      }).length
    : 0;
  return `<a class="cqa-back button-sm" href="#dialogs">${icon("arrow-left")}Все диалоги</a>${pageHeader(c.conversation_id, `${c.channel === "voice call" ? "Голосовой разговор" : "Чат с оператором"} · ${c.language || "Язык не указан"}`, actions)}<div class="cqa-detail-summary"><div class="cqa-detail-total"><span class="caption-2 cqa-muted">Итоговая оценка</span><div><strong class="heading-3 cqa-numeric">${score(ev?.total)}</strong><span class="body-6 cqa-muted"> / 100</span></div></div><div class="cqa-detail-fact"><span class="caption-2 cqa-muted">Результат</span>${statusBadge(ev?.status)}</div><div class="cqa-detail-fact"><span class="caption-2 cqa-muted">Требуют внимания</span><strong class="title-3">${assessed ? `${failed} из ${checklist.criteria.length}` : "—"}</strong></div><div class="cqa-detail-fact">${versionSelect(s, "detail-version", checklist.id)}</div></div>
    <div class="cqa-detail-layout">${transcript(c)}<section class="cqa-evaluation"><div class="cqa-evaluation-heading"><div><h2 class="heading-6">Оценка по критериям</h2><p class="caption-2 cqa-muted">Нажмите на доказательство, чтобы найти реплику</p></div><span class="cqa-count caption-4">${checklist.criteria.length}</span></div>${
      assessed
        ? `${ev.gross_error ? `<div class="cqa-inline-warning body-6">${icon("warning-circle")}Обнаружена грубая ошибка. Она отмечается отдельно от баллов.</div>` : ""}${checklist.sections
            .map((section) => {
              const criteria = checklist.criteria.filter(
                (c) => c.section === section.id,
              );
              if (!criteria.length) return "";
              return `<section class="cqa-criterion-section"><h3 class="caption-3 cqa-section-label">${e(section.title)}</h3>${criteria.map((crit) => criterionCard(crit, ev, s.appeals)).join("")}</section>`;
            })
            .join(
              "",
            )}<div class="cqa-evaluation-foot caption-5 cqa-muted"><span>Исходная оценка: ${score(ev.original_total)}</span><span>Расчётная стоимость: ${money(ev.cost_usd)}</span></div>`
        : emptyState(
            ev?.status === "error"
              ? "Не удалось оценить диалог"
              : "Здесь появится оценка",
            ev?.error ||
              "Запустите оценку, чтобы увидеть результаты и доказательства по каждому критерию.",
            button(
              "Оценить диалог",
              "evaluate-one",
              "play",
              true,
              s.job ? "disabled" : "",
            ),
          )
    }</section></div>`;
}
function criterionCard(c, ev, appeals) {
  const row = ev.criteria.find((r) => r.criterion_id === c.id);
  if (!row) return "";
  const r = row.final;
  const negative = c.gross_error ? r.answer === "yes" : r.answer === "no";
  const partial =
    c.type === "scale" &&
    r.answer !== "na" &&
    r.scale_value < Math.max(...c.scale.map((s) => s.value));
  const tone =
    r.answer === "na"
      ? "neutral"
      : negative
        ? "negative"
        : partial
          ? "partial"
          : "positive";
  const open = appeals.find(
    (a) =>
      a.evaluation_id === ev.id &&
      a.criterion_id === c.id &&
      a.status === "open",
  );
  const changed = JSON.stringify(row.original) !== JSON.stringify(row.final);
  return `<details class="cqa-criterion cqa-result-${tone}" ${negative || partial ? "open" : ""}><summary><span class="cqa-result-icon">${icon(tone === "negative" ? "x" : tone === "partial" ? "warning-circle" : tone === "neutral" ? "dots-three" : "check")}</span><span class="cqa-criterion-title"><span class="title-4">${e(c.title)}</span><span class="caption-5 cqa-muted">${c.gross_error ? "Без баллов" : `Баллы: ${score(row.points)} · вес ${score(row.effective_weight)}%`}</span></span><span class="cqa-answer caption-3">${resultLabel(c, r)}</span>${icon("caret-down", "cqa-details-chevron")}</summary><div class="cqa-criterion-body"><p class="body-6">${e(r.explanation)}</p><div class="cqa-evidence">${(r.evidence_ids || []).map((id) => `<button class="cqa-evidence-chip caption-4" data-evidence="${e(id)}">${icon("chat-circle-text")}${e(id)}${icon("arrow-up-right")}</button>`).join("")}${r.checked_range ? `<button class="cqa-range caption-4" data-range-from="${e(r.checked_range.from)}" data-range-to="${e(r.checked_range.to)}">${icon("list-checks")}Участок ${e(r.checked_range.from)} – ${e(r.checked_range.to)}</button>` : ""}</div><div class="cqa-criterion-footer">${changed ? `<span class="caption-5 cqa-reviewed">${icon("check-circle")}Изменено проверяющим</span>` : open ? '<span class="caption-5 cqa-muted">Апелляция на рассмотрении</span>' : "<span></span>"}<button class="cqa-text-button button-Xsm" data-appeal="${e(c.id)}" ${open ? "disabled" : ""}>${open ? "Апелляция открыта" : "Оспорить оценку"}${icon("arrow-up-right")}</button></div>${changed ? `<p class="cqa-original caption-5 cqa-muted">Ответ модели: ${resultLabel(c, row.original)}. ${e(row.original.explanation)}</p>` : ""}</div></details>`;
}
export function appealsPage(s) {
  const open = s.appeals.filter((a) => a.status === "open");
  const rows = s.appeals.filter((a) => a.status === s.appealFilter);
  return `${pageHeader("Апелляции", "Каждое решение остаётся в истории оценки.")}<div class="cqa-tabs" role="group" aria-label="Статус апелляций"><button class="button-sm ${s.appealFilter === "open" ? "is-active" : ""}" data-appeal-filter="open" aria-pressed="${s.appealFilter === "open"}">На рассмотрении <span class="cqa-count caption-4">${open.length}</span></button><button class="button-sm ${s.appealFilter === "decided" ? "is-active" : ""}" data-appeal-filter="decided" aria-pressed="${s.appealFilter === "decided"}">Решены <span class="cqa-count caption-4">${s.appeals.length - open.length}</span></button></div>${
    rows.length
      ? `<div class="cqa-appeals-list">${rows
          .map(
            (a) =>
              `<article class="cqa-panel cqa-appeal-card"><div class="cqa-appeal-heading"><span class="cqa-badge caption-4 ${a.status === "open" ? "cqa-status-queued" : "cqa-status-done"}">${icon(a.status === "open" ? "clock" : "check-circle")}${a.status === "open" ? "На рассмотрении" : "Решена"}</span><span class="caption-5 cqa-muted">${formatDate(a.created_at)}</span></div><h2 class="title-2">Оценка №${a.evaluation_id} <span class="cqa-muted">· ${e(a.criterion_id)}</span></h2><p class="body-6">${e(a.comment)}</p><div class="cqa-appeal-context">${a.messages
                .slice(0, 2)
                .map(
                  (m) =>
                    `<p class="caption-2"><span class="cqa-muted">${e(m.id)}</span> ${e(m.text)}</p>`,
                )
                .join(
                  "",
                )}</div><div class="cqa-appeal-actions">${button(a.status === "open" ? "Рассмотреть апелляцию" : "Открыть диалог", "review", "arrow-up-right", a.status === "open", `data-review="${a.id}"`)}</div></article>`,
          )
          .join("")}</div>`
      : emptyState(
          s.appealFilter === "open" ? "Все вопросы решены" : "Решений пока нет",
          s.appealFilter === "open"
            ? "Новые апелляции появятся здесь. Вы можете создать их в карточке диалога."
            : "Здесь будут апелляции после решения проверяющего.",
          `<a class="cqa-button cqa-secondary button-sm" href="#dialogs">${icon("arrow-left")}К диалогам</a>`,
        )
  }`;
}
export function checklistPage(s) {
  const c = s.checklist;
  return `${pageHeader("Чек-лист", "Сохранение создаёт новую версию. Прошлые оценки остаются в истории.", `<button class="cqa-button cqa-primary button-sm" type="submit" form="checklist-form" id="save-checklist">${icon("plus")}Сохранить новую версию</button>`)}<div class="cqa-checklist-bar">${versionSelect(s)}<p class="caption-2 cqa-muted">${c.criteria.length} критериев · ${c.sections.length} раздела</p></div><form id="checklist-form"><section class="cqa-panel cqa-checklist-settings"><label class="cqa-field"><span class="title-4">Название</span><input name="name" value="${e(c.name)}" required></label><label class="cqa-field"><span class="title-4">Порог первого ответа, секунд</span><input name="threshold" type="number" min="0" step="1" value="${c.first_reaction_threshold_sec ?? 180}" required></label></section>${c.sections
    .map(
      (section) =>
        `<section class="cqa-editor-section"><h2 class="title-3">${e(section.title)}</h2>${c.criteria
          .filter((v) => v.section === section.id)
          .map(
            (v) =>
              `<fieldset class="cqa-panel cqa-editor-row"><legend class="cqa-sr-only">${e(v.title)}</legend><div class="cqa-editor-number caption-3">${e(v.id)}</div><div class="cqa-editor-main"><label class="cqa-field"><span class="caption-2 cqa-muted">Критерий</span><input class="title-4" name="title:${e(v.id)}" value="${e(v.title)}" required></label><label class="cqa-field"><span class="caption-2 cqa-muted">Условия оценки</span><textarea name="description:${e(v.id)}" rows="3" required>${e(v.description)}</textarea></label><div class="cqa-editor-options"><label class="cqa-field cqa-weight-field"><span class="caption-2 cqa-muted">Вес</span><input type="number" name="weight:${e(v.id)}" min="0" step="any" value="${v.weight}" required></label><label class="cqa-checkbox body-6"><input type="checkbox" name="na:${e(v.id)}" ${v.na_allowed ? "checked" : ""} data-na="${e(v.id)}">Разрешить «Не применимо»</label></div><label class="cqa-field"><span class="caption-2 cqa-muted">Когда критерий не применяется</span><input name="condition:${e(v.id)}" value="${e(v.na_condition || "")}" ${v.na_allowed ? "required" : ""}></label>${v.type === "scale" ? `<div class="cqa-scale-preview caption-5 cqa-muted">Шкала: ${v.scale.map((p) => p.value).join(" · ")}</div>` : ""}</div><span class="cqa-badge cqa-status-empty caption-5">${v.gross_error ? "Грубая ошибка" : v.type === "scale" ? "Шкала" : "Да / Нет"}</span></fieldset>`,
          )
          .join("")}</section>`,
    )
    .join(
      "",
    )}<p id="checklist-error" class="cqa-form-error body-6" role="alert"></p></form>`;
}
export function statsPage(s) {
  const stats = s.stats,
    done = s.conversations.filter(
      (c) => c.status === "done" && c.total != null,
    );
  const bins = [
    [0, 50, "До 50"],
    [50, 70, "50–69"],
    [70, 90, "70–89"],
    [90, 101, "90–100"],
  ].map(([min, max, label]) => ({
    label,
    count: done.filter((c) => c.total >= min && c.total < max).length,
  }));
  return `${pageHeader("Статистика", "Результаты последних оценок и затраты на обработку.", button("Обновить", "refresh", "arrow-clockwise"))}<section class="cqa-summary">${metric("Успешных оценок", number(stats.evaluations_done), "Включая предыдущие версии")}${metric("Оценок с вызовами", number(stats.evaluations_with_calls), "Без полностью кешированных")}${metric("Вызовов модели", number(stats.calls), "Все попытки обработки")}${metric("Расчётная стоимость", money(stats.cost_usd), "За все вызовы", "cqa-metric-accent")}</section><div class="cqa-stats-layout"><section class="cqa-panel cqa-distribution"><h2 class="title-2">Распределение оценок</h2><p class="caption-2 cqa-muted">Последняя оценка каждого диалога</p>${done.length ? `<div class="cqa-bars">${bins.map((b) => `<div class="cqa-bar-row"><span class="caption-2">${b.label}</span><div class="cqa-bar-track"><div style="width:${(b.count / done.length) * 100}%"></div></div><strong class="caption-3">${b.count}</strong></div>`).join("")}</div><p class="caption-5 cqa-muted">${done.length} ${done.length === 1 ? "диалог" : "диалогов"} с числовой оценкой</p>` : emptyState("Пока нет оценок", "После первого прогона здесь появится распределение результатов.")}</section><section class="cqa-panel cqa-cost-details"><h2 class="title-2">Стоимость и обработка</h2><dl>${[
    ["Полная оценка, в среднем", money(stats.avg_cost_per_full_eval)],
    ["Оценка с вызовами, в среднем", money(stats.avg_cost_per_eval)],
    ["Использовано токенов", number(stats.tokens)],
    ["Время одного вызова", `${number(stats.avg_latency_ms / 1000, 2)} с`],
  ]
    .map(
      ([label, value]) =>
        `<div><dt class="body-6 cqa-muted">${label}</dt><dd class="title-4 cqa-numeric">${value}</dd></div>`,
    )
    .join(
      "",
    )}</dl><p class="caption-5 cqa-muted">Стоимость включает неудачные попытки. Полностью кешированные оценки не входят в среднюю стоимость вызовов.</p></section></div>`;
}
