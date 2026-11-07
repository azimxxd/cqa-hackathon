import { escape as e, emptyState, skeleton } from "./ui.js";
import { pageHeader } from "./views.js";

const criteriaNames = {
  contact: "Установление контакта", discovery: "Выявление потребности",
  identification: "Идентификация", consultation: "Консультация",
  empathy: "Эмпатия", dialogue: "Ведение диалога", closure: "Завершение",
  critical: "Грубое нарушение",
};
const validationMessages = {
  "Source IDs do not match the organizer import manifest": "ID диалогов не совпадают с реестром организаторов. Проверьте ID группы и импорт.",
  "Dataset size or channel composition does not match the official group": "Количество чатов или звонков не соответствует выбранному набору.",
  "Checklist version is incompatible with Results JSON 1.0": "Выберите официальную версию чек-листа, совместимую с Results JSON 1.0.",
  "test or unverifiable model name": "Сервер обнаружил тестовую модель или не смог подтвердить её название.",
  "Invalid conversation result status": "Набор ещё не содержит нужного количества результатов.",
};
const valueLabel = (v) => v === null ? "Не применимо" : v === true ? "Да" : v === false ? "Нет" : v;
const selected = (actual, expected) => String(actual) === String(expected) ? "selected" : "";
const formButton = (label, attributes, primary = false) =>
  `<button class="cqa-button ${primary ? "cqa-primary" : "cqa-secondary"} button-sm" ${attributes}>${label}</button>`;

export function submissionPage(s) {
  const p = s.submissionOptions;
  return `${pageHeader("Экспорт для жюри", "Проверьте состав группы и доказательства перед скачиванием Results JSON 1.0.")}
    <form id="submission-form" class="cqa-panel cqa-submission-form">
      <label class="cqa-field"><span class="title-4">Команда</span><input name="team_name" value="Saw-cell" readonly></label>
      <label class="cqa-field"><span class="title-4">Набор данных</span><select name="dataset"><option ${selected(p.dataset, "DEV")}>DEV</option><option ${selected(p.dataset, "PROD")}>PROD</option></select></label>
      <label class="cqa-field"><span class="title-4">ID группы организаторов</span><input name="group_id" value="${e(p.group_id)}" required autocomplete="off"><span class="caption-5 cqa-muted">Может отличаться от названия набора</span></label>
      <label class="cqa-field"><span class="title-4">Версия чек-листа</span><select name="checklist_version_id" required>${s.versions.map((v) => `<option value="${e(v.id)}" ${selected(p.checklist_version_id || s.version, v.id)}>№${e(v.id)} · ${e(v.name)}</option>`).join("")}</select></label>
      <label class="cqa-field"><span class="title-4">Источник оценок</span><select name="source"><option value="original" ${selected(p.source, "original")}>Исходные оценки</option><option value="final" ${selected(p.source, "final")}>Итоговые с решениями по апелляциям</option></select></label>
      <div>${formButton("Проверить набор", 'type="submit"', true)}</div>
    </form>
    <section id="submission-result" aria-label="Результаты проверки">${submissionEmpty()}</section>`;
}

export function submissionEmpty(changed = false) {
  return emptyState(changed ? "Параметры изменились" : "Предпросмотр ещё не загружен",
    "Выберите группу, версию и источник, затем нажмите «Проверить набор».");
}

export function submissionLoading() {
  return `<p class="body-6" role="status">Проверяем состав группы и оценки…</p>${skeleton()}`;
}

export function submissionError(message) {
  return `<div role="alert">${emptyState("Не удалось загрузить предпросмотр", message)}</div>`;
}

function dialogUrl(id, version, turn) {
  const params = new URLSearchParams({ version });
  if (turn !== undefined) params.set("turn", turn);
  return e(`#dialog/${encodeURIComponent(id)}?${params}`);
}

function resultRow(row, version) {
  const link = dialogUrl(row.conversation_id, version);
  return `<tr>
    <th scope="row"><a class="cqa-row-link title-4" href="${link}">${e(row.conversation_id)}</a></th>
    <td>${row.status === "error" ? '<strong class="cqa-badge cqa-status-error caption-4">Ошибка оценки</strong>' : "Оценён"}</td>
    <td>${e(row.score?.final_score ?? "—")}${row.score?.critical_flag ? '<p class="cqa-gross-label caption-5">Грубое нарушение</p>' : ""}</td>
    <td>${row.status === "error" ? `<p class="body-6">${e(row.error)}</p>` : `
      <details><summary class="title-4">Критерии<span class="cqa-sr-only"> диалога ${e(row.conversation_id)}</span></summary>
        <dl class="cqa-submission-criteria">${(row.criteria ?? []).map((c) => `<div>
          <dt class="title-4">${e(Object.hasOwn(criteriaNames, c.criterion_id) ? criteriaNames[c.criterion_id] : c.criterion_id)} · ${e(valueLabel(c.value))}</dt>
          <dd class="body-6">${e(c.rationale)}</dd>
          <dd class="caption-2 cqa-evidence">Реплики ${c.evidence_turns?.length ? c.evidence_turns.map((n) => `<a class="cqa-evidence-chip" href="${dialogUrl(row.conversation_id, version, n)}" aria-label="Открыть реплику №${e(n)}">№${e(n)}</a>`).join("") : "не указаны"}</dd>
        </div>`).join("")}</dl>
      </details>`}</td>
  </tr>`;
}

function messages(title, items) {
  return items?.length ? `<div class="cqa-inline-warning body-6"><div><strong>${title}</strong><ul>${items.map((item) => `<li>${e(Object.hasOwn(validationMessages, item) ? validationMessages[item] : item)}</li>`).join("")}</ul></div></div>` : "";
}

export function submissionReport(report, options, downloadError = "") {
  const doc = report.preview;
  const rows = doc?.results ?? [];
  const failed = rows.filter((row) => row.status === "error");
  const heading = !report.complete ? "Неполный набор" : failed.length ? "Полный набор с ошибками оценки" : "Полный набор";
  return `<div class="cqa-panel cqa-submission-report">
    <h2 class="heading-6">${heading}</h2>
    <p class="body-6" role="status">${report.ready === true ? "Файл доступен для скачивания." : "Скачивание заблокировано серверной проверкой."}</p>
    <p class="body-6">Диалоги ${e(report.actual_count)} из ${e(report.expected_count)} · Чаты ${e(report.channel_counts?.chat ?? "—")} · Звонки ${e(report.channel_counts?.call ?? "—")}${doc ? ` · Ошибки оценки ${failed.length}` : ""}</p>
    ${doc?.model ? `<p class="body-6">Модель ${e(doc.model.name)} · Режим ${e(doc.model.mode)}</p>` : ""}
    ${messages("Ошибки проверки набора", report.errors)}
    ${messages("Предупреждения", report.warnings)}
    ${failed.length ? `<p class="cqa-inline-warning body-6">В официальном JSON отмечены строки со статусом error. Причины указаны в таблице.</p>` : ""}
    <div>${formButton("Скачать Results JSON", `type="button" data-action="download-submission" ${report.ready === true ? "" : "disabled"}`, true)}</div>
    <p class="cqa-form-error body-6" id="submission-download-error" role="alert">${e(downloadError)}</p>
    ${report.source_ids?.length ? `<details><summary class="title-4">ID исходных диалогов</summary>
      <ul class="body-6">${report.source_ids.map((id) => `<li><a href="${dialogUrl(id, options.checklist_version_id)}">${e(id)}</a></li>`).join("")}</ul></details>` : ""}
    ${rows.length ? `<div class="cqa-table-wrap" tabindex="0" aria-label="Таблица оценок"><table class="cqa-table cqa-submission-table">
      <thead><tr><th scope="col">Диалог</th><th scope="col">Статус</th><th scope="col">Балл</th><th scope="col">Подробности</th></tr></thead>
      <tbody>${rows.map((row) => resultRow(row, options.checklist_version_id)).join("")}</tbody>
    </table></div>` : downloadError ? "" : emptyState("В предпросмотре нет диалогов", "Проверьте ID группы и импорт организаторского набора.")}
    ${doc ? '<details id="submission-json"><summary class="title-4">Официальный JSON</summary><pre class="body-6" tabindex="0" aria-label="Содержимое Results JSON"></pre></details>' : ""}
  </div>`;
}
