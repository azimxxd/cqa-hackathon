import { criterionEditor } from "./checklist-editor.js";
import {
  escape as e,
  icon,
  number,
  score,
  money,
  formatDate,
  statusBadge,
  emptyState,
  button,
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
function resultLabel(c, r) {
  if (r.answer === "na") return "Не применимо";
  if (c.type === "scale")
    return `${r.scale_value} / ${Math.max(...c.scale.map((v) => v.value))}`;
  return r.answer === "yes" ? "Да" : "Нет";
}
export function displayedTextSource(s) {
  return s.detail?.conversation.channel === "voice call" && s.textMode === "gemini" ? "gemini" : "original";
}
export function evaluationTextSource(s) {
  const source = displayedTextSource(s);
  if (source === "gemini" && (s.transcription?.status !== "done" || s.transcriptionStale)) return null;
  return source;
}
export function assessmentBasis(s) {
  const { evaluation: ev } = s.detail;
  const displayed = displayedTextSource(s);
  const assessed = ev?.transcript_source === "gemini" ? "gemini" : "original";
  const label = (source) => source === "gemini" ? "расшифровка Gemini" : "исходный текст";
  return `${ev?.status === "done" ? `<p>Текст для оценки: ${label(assessed)}${assessed === "gemini" && ev.transcription_model ? ` · ${e(ev.transcription_model)}` : ""}.</p>
    ${assessed !== displayed ? `<p>Сейчас открыт другой текст: ${label(displayed)}.</p>` : ""}` : ""}
    ${displayed === "gemini" && s.transcriptionStale ? `<p class="cqa-form-error" role="alert">Сервер больше не подтверждает актуальность этой расшифровки. Обновите диалог, чтобы проверить её доступность.</p>${button("Обновить диалог","refresh","arrow-clockwise")}` :
      displayed === "gemini" && !evaluationTextSource(s) ? "<p>Переоценка по Gemini доступна после завершения расшифровки.</p>" : ""}`;
}
export function assessmentAction(s) {
  if (s.job) return "Оценка выполняется";
  const verb = s.detail.evaluation?.status === "done" ? "Переоценить" : "Оценить";
  if (s.detail.conversation.channel !== "voice call") return `${verb} диалог`;
  return displayedTextSource(s) === "gemini" ? `${verb} по Gemini` : `${verb} по оригиналу`;
}
export function scorecard(s) {
  const { evaluation: ev, checklist } = s.detail;
  const assessed = ev?.status === "done";
  const actions = button(
    assessmentAction(s),
    "evaluate-one",
    "play",
    true,
    `aria-describedby="assessment-basis" ${s.job || !s.ai?.configured || !evaluationTextSource(s) ? "disabled" : ""}`,
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
  return `<div class="cqa-score-ledger"><div><p class="caption-2 cqa-muted">Итоговая оценка</p><strong class="heading-3 cqa-numeric">${score(ev?.total)}</strong><span class="body-6 cqa-muted"> / 100</span></div><div>${statusBadge(ev?.status)}${actions}</div><p class="caption-2 cqa-muted">${assessed ? `Требуют внимания: ${failed} из ${checklist.criteria.length}` : ""}</p>${versionSelect(s, "detail-version", checklist.id)}<div id="assessment-basis" class="caption-2 cqa-muted" aria-live="polite">${assessmentBasis(s)}</div></div>
    <section class="cqa-evaluation"><div class="cqa-evaluation-heading"><div><h2 class="heading-6">Оценка по критериям</h2><p class="caption-2 cqa-muted">Нажмите на доказательство, чтобы найти реплику</p></div><span class="cqa-count caption-4">${checklist.criteria.length}</span></div>${
      assessed
        ? `${ev.gross_error ? `<div class="cqa-inline-warning body-6">${icon("warning-circle")}Обнаружена грубая ошибка. Она отмечается отдельно от баллов.</div>` : ""}${checklist.sections
            .map((section) => {
              const criteria = checklist.criteria.filter(
                (c) => c.section === section.id,
              );
              if (!criteria.length) return "";
              return `<section class="cqa-criterion-section"><h3 class="caption-3 cqa-section-label">${e(section.title)}</h3>${criteria.map((crit) => criterionCard(crit, ev, s.appeals, s.role)).join("")}</section>`;
            })
            .join(
              "",
            )}<div class="cqa-evaluation-foot caption-5 cqa-muted"><span>Исходная оценка: ${score(ev.original_total)}${ev.model ? ` · ${e(ev.model)}` : ""}</span><span>${ev.source === "algos" || ev.usage_available === false ? `${ev.source === "algos" ? "Импорт из Algos · " : ""}Токены и стоимость API не измерялись` : `Расчётная стоимость: ${money(ev.cost_usd)}`}</span></div>`
        : emptyState(
            ev?.status === "error"
              ? "Не удалось оценить диалог"
              : "Здесь появится оценка",
            ev?.error ||
              "Запустите оценку, чтобы увидеть результаты и доказательства по каждому критерию.",
          )
    }</section>`;
}
function criterionCard(c, ev, appeals, role) {
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
  const appealAction = role === "reviewer"
    ? open ? `<button class="cqa-text-button button-Xsm" data-review="${e(open.id)}">Рассмотреть апелляцию${icon("arrow-up-right")}</button>` : ""
    : `<button class="cqa-text-button button-Xsm" data-appeal="${e(c.id)}" ${open ? "disabled" : ""}>${open ? "Апелляция открыта" : "Оспорить оценку"}${icon("arrow-up-right")}</button>`;
  const changed = JSON.stringify(row.original) !== JSON.stringify(row.final);
  return `<details class="cqa-criterion cqa-result-${tone}" ${negative || partial ? "open" : ""}><summary><span class="cqa-result-icon">${icon(tone === "negative" ? "x" : tone === "partial" ? "warning-circle" : tone === "neutral" ? "dots-three" : "check")}</span><span class="cqa-criterion-title"><span class="title-4">${e(c.title)}</span><span class="caption-5 cqa-muted">${c.gross_error ? "Без баллов" : `Баллы: ${score(row.points)} · вес ${score(row.effective_weight)}%`}</span></span><span class="cqa-answer caption-3">${e(resultLabel(c, r))}</span>${icon("caret-down", "cqa-details-chevron")}</summary><div class="cqa-criterion-body"><p class="body-6">${e(r.explanation)}</p><div class="cqa-evidence">${(r.evidence_ids || []).map((id) => `<button class="cqa-evidence-chip caption-4" data-evidence="${e(id)}">${icon("chat-circle-text")}${e(id)}${icon("arrow-up-right")}</button>`).join("")}${r.checked_range ? `<button class="cqa-range caption-4" data-range-from="${e(r.checked_range.from)}" data-range-to="${e(r.checked_range.to)}">${icon("list-checks")}Участок ${e(r.checked_range.from)} – ${e(r.checked_range.to)}</button>` : ""}</div><div class="cqa-criterion-footer">${changed ? `<span class="caption-5 cqa-reviewed">${icon("check-circle")}Изменено проверяющим</span>` : open ? '<span class="caption-5 cqa-muted">Апелляция на рассмотрении</span>' : "<span></span>"}${appealAction}</div>${changed ? `<p class="cqa-original caption-5 cqa-muted">Ответ модели: ${e(resultLabel(c, row.original))}. ${e(row.original.explanation)}</p>` : ""}</div></details>`;
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
export function checklistPage(s, drawer = false) {
  const c = s.checklist;
  const save = `<button class="cqa-button cqa-primary button-sm" type="submit" form="checklist-form" id="save-checklist">${icon("plus")}Сохранить новую версию</button>`;
  const heading = drawer
    ? `<div class="cqa-drawer-heading"><h2 class="heading-6" id="checklist-title" tabindex="-1">Настройка чек-листа</h2><p class="caption-2 cqa-muted">Сохранение создаёт новую версию.</p>${save}</div>`
    : pageHeader("Чек-лист", "Сохранение создаёт новую версию. Оценка диалогов запускается отдельно.", save);
  return `${heading}<div class="cqa-checklist-bar">${versionSelect(s, drawer ? "drawer-version" : "version-select")}</div>
    <p class="cqa-inline-warning body-6">${icon("warning-circle")}Изменение официальных критериев может сделать версию несовместимой с форматом Results JSON 1.0.</p>
    <form id="checklist-form">
      <section class="cqa-panel cqa-checklist-settings">
        <label class="cqa-field"><span class="title-4">Название</span><input name="name" value="${e(c.name)}" required></label>
        <label class="cqa-field"><span class="title-4">Порог первого ответа, секунд</span><input name="threshold" type="number" min="0" step="any" value="${e(c.first_reaction_threshold_sec ?? 180)}" required></label>
      </section>
      <div data-criteria>${c.criteria.map((v) => criterionEditor(v, c.sections)).join("")}</div>
      <button class="cqa-button cqa-secondary button-sm" type="button" data-editor="add-criterion" ${c.sections.length ? "" : "disabled"}>${icon("plus")}Добавить критерий</button>
      <p id="checklist-error" class="cqa-form-error body-6" role="alert"></p>
    </form>`;
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
  return `${pageHeader("Статистика", "Результаты последних оценок и затраты на обработку.", button("Обновить", "refresh", "arrow-clockwise"))}<section class="cqa-summary">${metric("Успешных оценок", number(stats.evaluations_done), "Включая предыдущие версии")}${metric("Оценок с вызовами", number(stats.evaluations_with_calls), "Без полностью кешированных")}${metric("Вызовов модели", number(stats.calls), "Все попытки обработки")}${metric("Расчётная стоимость", stats.calls ? money(stats.cost_usd) : "—", "По учтённым вызовам", "cqa-metric-accent")}</section><div class="cqa-stats-layout"><section class="cqa-panel cqa-distribution"><h2 class="title-2">Распределение оценок</h2><p class="caption-2 cqa-muted">Последняя оценка каждого диалога</p>${done.length ? `<div class="cqa-bars">${bins.map((b) => `<div class="cqa-bar-row"><span class="caption-2">${b.label}</span><div class="cqa-bar-track"><div style="width:${(b.count / done.length) * 100}%"></div></div><strong class="caption-3">${b.count}</strong></div>`).join("")}</div><p class="caption-5 cqa-muted">${done.length} ${done.length === 1 ? "диалог" : "диалогов"} с числовой оценкой</p>` : emptyState("Пока нет оценок", "После первого прогона здесь появится распределение результатов.")}</section><section class="cqa-panel cqa-cost-details"><h2 class="title-2">Стоимость и обработка</h2><dl>${[
    ["Полная оценка, в среднем", stats.calls ? money(stats.avg_cost_per_full_eval) : "—"],
    ["Оценка с вызовами, в среднем", stats.calls ? money(stats.avg_cost_per_eval) : "—"],
    ["Использовано токенов", stats.calls ? number(stats.tokens) : "—"],
    ["Время одного вызова", stats.calls ? `${number(stats.avg_latency_ms / 1000, 2)} с` : "—"],
  ]
    .map(
      ([label, value]) =>
        `<div><dt class="body-6 cqa-muted">${label}</dt><dd class="title-4 cqa-numeric">${value}</dd></div>`,
    )
    .join(
      "",
    )}</dl><p class="caption-5 cqa-muted">Для импортированных оценок Algos токены и стоимость API не измерялись. Статистика вызовов включает неудачные попытки. Полностью кешированные оценки не входят в среднюю стоимость вызовов.</p></section></div>`;
}
