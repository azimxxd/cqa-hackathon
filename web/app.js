import { workspacePage, feedRows, feedList, datasetRows, auditContents, jobProgress, transcriptControls, transcriptMessages } from "./workspace.js";
import { submissionPage, submissionEmpty, submissionLoading, submissionError, submissionReport } from "./submission.js";
import { editChecklist, readChecklist, updateCriterionControls } from "./checklist-editor.js";
import { api } from "./api.js";
import { escape as e, icon, button, emptyState, skeleton, time } from "./ui.js";
import {
  appealsPage,
  assessmentAction,
  assessmentBasis,
  evaluationTextSource,
  checklistPage,
  scorecard,
  statsPage,
} from "./views.js";

const root = document.getElementById("cqa-root");
const state = {
  conversations: [],
  versions: [],
  appeals: [],
  stats: {},
  version: null,
  route: "dialogs",
  search: "",
  filter: "all",
  role: "operator",
  group: "",
  datasetIds: null,
  selected: null,
  drawer: false,
  drawerError: null,
  textMode: "original",
  transcription: null,
  transcriptionStale: false,
  ai: null,
  aiError: null,
  appealFilter: "open",
  detail: null,
  checklist: null,
  loading: true,
  error: null,
  job: null,
  notice: null,
  modal: null,
  submissionOptions: { dataset: "DEV", group_id: "DEV", source: "final" },
};
let submissionRequest = 0, submissionSnapshot;
let drawerToken = 0;
let routeToken = 0,
  noticeTimer;
const nav = [
  ["dialogs", "chats", "Диалоги"],
  ["appeals", "scales", "Апелляции"],
  ["checklist", "list-checks", "Чек-лист"],
  ["submission", "upload-simple", "Экспорт для жюри"],
  ["stats", "chart-bar", "Статистика"],
];
const isWorkspace = () => ["dialogs", "dialog"].includes(state.route);
function studioHeader(active, count) {
  const ai = state.ai;
  const modelStatus = ai
    ? [ai.mode === "auto" ? `авто: ${ai.provider === "ollama" ? "Qwen на GPU" : "Gemini (GPU выключен)"}` : ai.provider, ai.model, ai.configured ? "настроено" : "не настроено"].filter(Boolean).join(" · ")
    : state.aiError ? `Статус модели недоступен: ${state.aiError}` : "Проверяем статус модели";
  return `<header class="cqa-studio-header">
    <a class="cqa-brand" href="#dialogs" aria-label="CQA, к диалогам"><span class="cqa-brand-mark"><i></i><i></i><i></i></span><span class="cqa-brand-word heading-5">cqa<span>.</span></span></a>
    <nav aria-label="Основная навигация">${nav.map(([id,glyph,label]) => `<a class="cqa-nav-link title-4" href="#${id}" ${id === active ? 'aria-current="page"' : ""}>${icon(glyph)}${label}${id === "appeals" && count ? ` <span class="cqa-nav-count caption-4">${count}</span>` : ""}</a>`).join("")}</nav>
    ${isWorkspace() ? `<div class="cqa-studio-toolbar">
      <div class="cqa-studio-actions" role="group" aria-label="Режим работы">${[["operator","Оператор"],["reviewer","Проверяющий"]].map(([id,label]) => `<button class="cqa-studio-chip caption-3" data-role="${id}" aria-pressed="${state.role === id}">${label}</button>`).join("")}</div>
      ${button("Редактор чек-листа","checklist-drawer","list-checks",false,`aria-expanded="${state.drawer}"`)}
      <form id="dataset-form" class="cqa-studio-actions">
        <label class="caption-3">Выборка <input name="group" value="${e(state.group)}" placeholder="Все" maxlength="128" autocomplete="off"></label>
        <button class="cqa-studio-chip caption-3" type="submit">Открыть</button>
        ${button("Импортировать","import","upload-simple")}
        <span id="dataset-error" class="caption-5" role="alert"></span>
      </form><span class="cqa-model-status caption-5" role="status">${e(modelStatus)}</span></div>` : ""}
    </header>`;
}
function render() {
  const active = state.route === "dialog" ? "dialogs" : state.route;
  document.title = `${state.route === "dialog" && state.detail ? state.detail.conversation.conversation_id : nav.find((n) => n[0] === active)?.[2] || "Страница не найдена"} · CQA`;
  let content;
  if (isWorkspace()) content = workspacePage(state);
  else if (state.loading) content = skeleton();
  else if (state.error)
    content = `<div class="cqa-page-error" role="alert">${emptyState("Не удалось загрузить данные", state.error, button("Попробовать снова", "refresh", "arrow-clockwise", true))}</div>`;
  else
    content = (
      {
        appeals: appealsPage,
        checklist: checklistPage,
        stats: statsPage,
        submission: submissionPage,
      }[state.route] ||
      (() =>
        emptyState(
          "Страница не найдена",
          "Вернитесь к списку диалогов.",
          `<a class="cqa-button cqa-primary button-sm" href="#dialogs">К диалогам</a>`,
        ))
    )(state);
  const count = state.appeals.filter((a) => a.status === "open").length;
  root.innerHTML = `<a class="cqa-skip button-sm" href="#main-content" data-action="skip-main">Перейти к содержимому</a><div class="cqa-studio-shell ${isWorkspace() ? "is-workspace" : ""}">${studioHeader(active,count)}<main class="cqa-main" id="main-content" tabindex="-1">${content}</main></div><div class="cqa-toast body-6 ${state.notice ? "is-visible" : ""}" role="status" data-tone="${state.notice?.tone || "success"}">${icon(state.notice?.tone === "error" ? "warning-circle" : "check-circle")}<span>${e(state.notice?.message || "")}</span></div><dialog id="cqa-modal" class="cqa-modal" aria-labelledby="modal-title"></dialog>`;
}
function toast(message, tone = "success") {
  clearTimeout(noticeTimer);
  state.notice = { message, tone };
  const node = root.querySelector(".cqa-toast");
  if (node) {
    node.dataset.tone = tone;
    node.innerHTML = `${icon(tone === "error" ? "warning-circle" : "check-circle")}<span>${e(message)}</span>`;
    node.classList.add("is-visible");
  }
  noticeTimer = setTimeout(() => {
    state.notice = null;
    root.querySelector(".cqa-toast")?.classList.remove("is-visible");
  }, 6000);
}
async function loadAI() {
  try {
    state.ai = await api.aiStatus();
    state.aiError = null;
  } catch (error) {
    state.ai = null;
    state.aiError = error.message;
  }
}
async function summary() {
  const [conversations, versions, stats, appeals] = await Promise.all([
    api.conversations(),
    api.checklists(),
    api.stats(),
    api.appeals(),
  ]);
  const disputed = [...new Set(appeals.filter((a) => a.status === "open").map((a) => a.evaluation_id))];
  const evaluations = await Promise.allSettled(disputed.map(api.evaluationById));
  const byId = new Map(evaluations.filter((r) => r.status === "fulfilled").map(({ value }) => [value.id, value.conversation_id]));
  Object.assign(state, { conversations, versions, stats,
    appeals: appeals.map((a) => ({ ...a, conversation_id: byId.get(a.evaluation_id) })) });
  state.disputesIncomplete = evaluations.some((r) => r.status === "rejected");
  if (!state.version) state.version = versions[0]?.id;
}
function routeInfo() {
  const [path, query] = (location.hash.slice(1) || "dialogs").split("?");
  const params = new URLSearchParams(query);
  if (path.startsWith("dialog/"))
    return {
      page: "dialog",
      id: decodeURIComponent(path.slice(7)),
      version: params.get("version"),
      evaluationId: params.get("evaluation"),
      turn: Number(params.get("turn")),
    };
  return { page: path };
}
async function loadPage(options = {}) {
  const token = ++routeToken;
  drawerToken++;
  let route;
  try {
    route = routeInfo();
  } catch {
    route = { page: "missing" };
  }
  submissionSnapshot = null;
  state.route = route.page;
  if (!isWorkspace()) state.drawer = false;
  state.detail = null;
  state.transcription = null;
  state.transcriptionStale = false;
  state.textMode = "original";
  state.loading = true;
  state.error = null;
  render();
  try {
    if (options.refresh) await Promise.all([summary(), loadAI()]);
    if (token !== routeToken) return;
    if (isWorkspace()) {
      const id = route.id ?? feedRows(state)[0]?.conversation_id;
      state.selected = id ?? null;
      if (id != null) {
        const conversation = await api.conversation(id);
        const version = route.version;
        const evaluationId = route.evaluationId;
        const evaluation = evaluationId
          ? await api.evaluationById(evaluationId)
          : await api.evaluation(id, version).catch((error) => {
              if (error.status === 404) return null;
              throw error;
            });
        if (
          evaluation &&
          evaluation.conversation_id !== conversation.conversation_id
        )
          throw Error("Эта оценка относится к другому диалогу.");
        const checklist = await api.checklist(
          evaluation?.checklist_version_id || version || state.version,
        );
        if (token !== routeToken) return;
        state.detail = { conversation, evaluation, checklist };
        if (conversation.channel === "voice call") state.transcription = { status: "loading" };
      }
    }
    if (state.drawer || route.page === "checklist") {
      try {
        const checklist = await api.checklist(state.version);
        if (token !== routeToken) return;
        state.checklist = checklist;
        state.drawerError = null;
      } catch (error) {
        if (!state.drawer) throw error;
        if (token !== routeToken) return;
        state.drawerError = error.message;
      }
    }
    if (token !== routeToken) return;
    state.loading = false;
    render();
    if (state.detail?.conversation.channel === "voice call") {
      readTranscription(state.selected, token);
    }
    if (options.focus) {
      window.scrollTo({ top: 0, behavior: "instant" });
      root.querySelector("#page-title")?.focus({ preventScroll: state.route !== "dialog" });
    }
    if (route.page === "dialog" && Number.isInteger(route.turn) && route.turn > 0) {
      const message = state.detail.conversation.messages.find((m) => m.idx === route.turn - 1);
      if (message) highlightEvidence(message.id);
    }
  } catch (error) {
    if (token !== routeToken) return;
    state.loading = false;
    state.error = error.message;
    render();
  }
}
function updateTranscript(redrawMessages = false) {
  updateAssessmentControls();
  const controls = root.querySelector("#transcript-controls");
  if (controls) {
    const mode = document.activeElement?.dataset.transcript;
    controls.innerHTML = transcriptControls(state);
    if (mode) controls.querySelector(`[data-transcript="${CSS.escape(mode)}"]`)?.focus();
  }
  const messages = root.querySelector("#transcript-messages");
  if (redrawMessages && messages && state.detail) {
    const scroll = messages.scrollTop;
    const highlighted = new Set([...messages.querySelectorAll(".is-highlighted")].map((m) => m.dataset.message));
    messages.innerHTML = transcriptMessages(state.detail.conversation, state.transcription, state.textMode);
    messages.querySelectorAll("[data-message]").forEach((m) => m.classList.toggle("is-highlighted", highlighted.has(m.dataset.message)));
    messages.scrollTop = scroll;
  }
}
async function readTranscription(id, token, start = false) {
  try {
    let result = await (start ? api.transcribe(id) : api.transcription(id));
    while (token === routeToken) {
      state.transcription = result;
      updateTranscript();
      if (result.status !== "running") return;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (token !== routeToken) return;
      result = await api.transcription(id);
    }
  } catch (error) {
    if (token !== routeToken) return;
    state.transcription = { status: "error", error: error.message };
    updateTranscript();
  }
}
async function toggleDrawer(trigger) {
  state.drawer = !state.drawer;
  root.querySelector(".cqa-studio-toolbar [data-action=checklist-drawer]")?.setAttribute("aria-expanded", String(state.drawer));
  const audit = root.querySelector(".cqa-audit");
  if (!audit) return;
  const redraw = () => {
    audit.innerHTML = auditContents(state);
    audit.setAttribute("aria-label", state.drawer ? "Редактор чек-листа" : "Оценка диалога");
  };
  const request = ++drawerToken;
  if (!state.drawer) {
    redraw();
    if (trigger.closest(".cqa-audit") === audit || !trigger.isConnected)
      root.querySelector(".cqa-studio-toolbar [data-action=checklist-drawer]")?.focus();
    return;
  }
  state.checklist = null;
  state.drawerError = null;
  redraw();
  const token = routeToken;
  try {
    const checklist = await api.checklist(state.version);
    if (token !== routeToken || request !== drawerToken || !state.drawer) return;
    state.checklist = checklist;
    redraw();
    audit.querySelector("#checklist-title")?.focus();
    audit.scrollTop = 0;
  } catch (error) {
    if (token !== routeToken || request !== drawerToken || !state.drawer) return;
    state.drawerError = error.message;
    redraw();
  }
}
async function datasetIds(group) {
  if (!group) return null;
  const report = await api.submissionPreview({
    group_id: group, dataset: group === "PROD" ? "PROD" : "DEV",
    checklist_version_id: state.version, source: "final", team_name: "Saw-cell",
  });
  if (!Array.isArray(report.source_ids)) throw Error("Состав выборки недоступен.");
  return new Set(report.source_ids);
}
function updateFeed() {
  root.querySelector("#dialog-feed").innerHTML = feedList(state);
  root.querySelector("#dispute-warning").hidden = state.filter !== "appeals" || !state.disputesIncomplete;
  const rows = feedRows(state);
  const index = rows.findIndex((row) => row.conversation_id === state.selected);
  root.querySelectorAll("[data-adjacent]").forEach((b) => {
    b.disabled = index < 0 || !rows[index + Number(b.dataset.adjacent)];
  });
}
async function openDataset(form) {
  const group = form.elements.group.value.trim();
  const token = routeToken;
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  form.querySelector("#dataset-error").textContent = "";
  try {
    // The canonical jury preview exposes the actual persisted group IDs,
    // including partial groups whose export isn't ready.
    const ids = await datasetIds(group);
    if (token !== routeToken || !form.isConnected) return;
    state.group = group;
    state.datasetIds = ids;
    state.search = "";
    state.filter = "all";
    if (state.route === "dialog") location.hash = "dialogs";
    else await loadPage({ focus: true });
  } catch (error) {
    if (form.isConnected) form.querySelector("#dataset-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}
function navigate(id) {
  location.hash = `dialog/${encodeURIComponent(id)}`;
}
function modal(title, body, kind, context = {}) {
  state.modal = { kind, ...context };
  const node = root.querySelector("#cqa-modal");
  node.innerHTML = `<form id="modal-form"><div class="cqa-modal-heading"><h2 class="heading-5" id="modal-title">${e(title)}</h2><button class="cqa-icon-button" type="button" data-action="close-modal" aria-label="Закрыть">${icon("x")}</button></div>${body}<p id="modal-error" class="cqa-form-error body-6" role="alert"></p></form>`;
  node.showModal();
  node.addEventListener(
    "close",
    () => {
      state.modal = null;
    },
    { once: true },
  );
}
function modalActions(label) {
  return `<div class="cqa-modal-actions"><button type="button" class="cqa-button cqa-secondary button-sm" data-action="close-modal">Отмена</button><button type="submit" class="cqa-button cqa-primary button-sm">${e(label)}</button></div>`;
}
function openImport() {
  modal(
    "Импорт диалогов",
    `<p class="body-6 cqa-muted">Укажите группу данных организаторов. Уже импортированные диалоги сохранят свои оценки.</p><label class="cqa-field"><span class="title-4">ID группы</span><input name="group" value="${e(state.group)}" placeholder="Например, DEV" required autocomplete="off"></label>${modalActions("Импортировать")}`,
    "import",
  );
}
function openAppeal(id) {
  const c = state.detail.checklist.criteria.find((c) => c.id === id);
  modal(
    "Оспорить оценку",
    `<div class="cqa-modal-context"><p class="title-4">${e(c.title)}</p><p class="caption-2 cqa-muted">${e(state.detail.conversation.conversation_id)}</p></div><label class="cqa-field"><span class="title-4">Почему оценку нужно пересмотреть?</span><textarea name="comment" placeholder="Опишите, что стоит учесть проверяющему" rows="5" required></textarea></label>${modalActions("Отправить апелляцию")}`,
    "appeal",
    { criterionId: id, evaluationId: state.detail.evaluation.id },
  );
}
async function openReview(id) {
  const appeal = state.appeals.find((a) => a.id === Number(id));
  const token = routeToken;
  try {
    const evaluation = await api.evaluationById(appeal.evaluation_id);
    if (token !== routeToken) return;
    if (appeal.status === "decided") {
      location.hash = `dialog/${encodeURIComponent(evaluation.conversation_id)}?evaluation=${evaluation.id}`;
      return;
    }
    const [checklist, conversation] = await Promise.all([
      api.checklist(evaluation.checklist_version_id),
      api.conversation(evaluation.conversation_id),
    ]);
    if (token !== routeToken) return;
    const criterion = checklist.criteria.find(
        (c) => c.id === appeal.criterion_id,
      ),
      result = evaluation.criteria.find(
        (c) => c.criterion_id === appeal.criterion_id,
      ).final;
    const options =
      criterion.type === "scale"
        ? criterion.scale.map((s) => [
            `scale:${s.value}`,
            `${s.value} — ${s.label}`,
          ])
        : [
            ["yes", "Да"],
            ["no", "Нет"],
          ];
    if (criterion.na_allowed) options.push(["na", "Не применимо"]);
    const selected =
      result.answer === "na"
        ? "na"
        : criterion.type === "scale"
          ? `scale:${result.scale_value}`
          : result.answer;
    const messageOptions = (value) =>
      `<option value="">Не задан</option>${conversation.messages.map((m) => `<option value="${e(m.id)}" ${m.id === value ? "selected" : ""}>${e(m.id)} · ${time(m.offset_sec)} · ${e(m.text.slice(0, 55))}</option>`).join("")}`;
    modal(
      "Решение по апелляции",
      `<div class="cqa-modal-context"><p class="title-4">${e(criterion.title)}</p><p class="caption-2 cqa-muted">${e(evaluation.conversation_id)} · Версия ${checklist.id}</p><p class="body-6">${e(appeal.comment)}</p></div><p class="caption-2 cqa-muted">Текущая оценка</p><p class="body-6">${e(result.explanation)}</p><label class="cqa-field"><span class="title-4">Решение</span><select name="action" id="review-action"><option value="confirm">Подтвердить текущую оценку</option><option value="change">Изменить оценку</option></select></label><div id="review-change" hidden><label class="cqa-field"><span class="title-4">Новый ответ</span><select name="answer">${options.map(([v, label]) => `<option value="${e(v)}" ${v === selected ? "selected" : ""}>${e(label)}</option>`).join("")}</select></label><label class="cqa-field"><span class="title-4">Доказательства</span><input name="evidence" value="${e(result.evidence_ids.join(", "))}" placeholder="m004, m007"><span class="caption-5 cqa-muted">ID реплик через запятую</span></label><div class="cqa-form-grid"><label class="cqa-field"><span class="caption-2">Начало участка</span><select name="from">${messageOptions(result.checked_range?.from)}</select></label><label class="cqa-field"><span class="caption-2">Конец участка</span><select name="to">${messageOptions(result.checked_range?.to)}</select></label></div></div><label class="cqa-field"><span class="title-4">Обоснование решения</span><textarea name="reason" rows="3" required placeholder="Что вы проверили и почему приняли это решение"></textarea></label>${modalActions("Сохранить решение")}`,
      "review",
      { appealId: appeal.id },
    );
  } catch (error) {
    toast(error.message, "error");
  }
}
async function submitModal(form) {
  const context = state.modal;
  if (!context) return;
  const data = new FormData(form),
    submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  form.querySelector("#modal-error").textContent = "";
  try {
    let message;
    if (context.kind === "import") {
      const group = data.get("group").trim();
      const r = await api.importGroup(group);
      if (state.group === group) state.datasetIds = await datasetIds(group);
      message = `Импортировано диалогов: ${r.imported}`;
    }
    if (context.kind === "appeal") {
      await api.appeal({
        evaluation_id: context.evaluationId,
        criterion_id: context.criterionId,
        comment: data.get("comment").trim(),
      });
      message = "Апелляция отправлена на рассмотрение";
    }
    if (context.kind === "review") {
      const body = {
        action: data.get("action"),
        reason: data.get("reason").trim(),
      };
      if (body.action === "change") {
        const answer = data.get("answer");
        body.new_answer = answer.startsWith("scale:") ? null : answer;
        body.new_scale_value = answer.startsWith("scale:")
          ? Number(answer.slice(6))
          : null;
        body.new_evidence_ids = data
          .get("evidence")
          .split(/[\s,]+/)
          .filter(Boolean);
        const from = data.get("from"),
          to = data.get("to");
        if (!!from !== !!to)
          throw Error("Укажите начало и конец участка проверки.");
        body.new_checked_range = from && to ? { from, to } : null;
      }
      await api.decide(context.appealId, body);
      message = "Решение сохранено. Итог оценки пересчитан";
    }
    root.querySelector("#cqa-modal").close();
    await loadPage({ refresh: true });
    toast(message);
  } catch (error) {
    form.querySelector("#modal-error").textContent = error.message;
    submit.disabled = false;
  }
}
async function saveChecklist(form) {
  const submit = root.querySelector("#save-checklist"),
    errorNode = root.querySelector("#checklist-error");
  submit.disabled = true;
  errorNode.textContent = "";
  try {
    const body = readChecklist(form, state.checklist);
    form.inert = true;
    const saved = await api.saveChecklist(body);
    state.version = saved.id;
    await loadPage({ refresh: true });
    toast(`Версия ${saved.id} сохранена. Предыдущие оценки доступны в истории`);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.scrollIntoView({ block: "center" });
    form.inert = false;
    submit.disabled = false;
  }
}
function submissionOptions(form) {
  const options = Object.fromEntries(new FormData(form));
  options.group_id = options.group_id.trim();
  return options;
}
function displaySubmission(region, report, options, error) {
  region.innerHTML = submissionReport(report, options, error);
  region.querySelector("#submission-json")?.addEventListener("toggle", (event) => {
    const details = event.currentTarget;
    if (details.open) {
      const pre = details.querySelector("pre");
      if (!pre.textContent) pre.textContent = JSON.stringify(report.preview, null, 2);
    }
  });
}
async function previewSubmission(form) {
  const options = submissionOptions(form);
  if (!options.group_id) {
    const input = form.elements.group_id;
    input.setCustomValidity("Укажите ID группы организаторов.");
    input.reportValidity();
    return;
  }
  const request = ++submissionRequest;
  const region = root.querySelector("#submission-result");
  const submit = form.querySelector('[type="submit"]');
  state.submissionOptions = options;
  submissionSnapshot = null;
  submit.disabled = true;
  region.innerHTML = submissionLoading();
  try {
    const report = await api.submissionPreview(options);
    if (!region.isConnected || request !== submissionRequest) return;
    submissionSnapshot = { options, report };
    displaySubmission(region, report, options);
  } catch (error) {
    if (region.isConnected && request === submissionRequest)
      region.innerHTML = submissionError(error.message);
  } finally {
    if (region.isConnected && request === submissionRequest) submit.disabled = false;
  }
}
async function downloadSubmission(button) {
  const snapshot = submissionSnapshot;
  if (snapshot?.report.ready !== true) return;
  const region = root.querySelector("#submission-result");
  const errorNode = region.querySelector("#submission-download-error");
  errorNode.textContent = "";
  button.disabled = true;
  try {
    const blob = await api.submissionDownload(snapshot.options);
    if (!region.isConnected || submissionSnapshot !== snapshot) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${snapshot.options.dataset.toLowerCase()}-results.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (!region.isConnected || submissionSnapshot !== snapshot) return;
    if (error.status === 409) {
      const report = { ...snapshot.report, ...error.details, preview: null };
      submissionSnapshot = null;
      displaySubmission(region, { ...report, ready: false }, snapshot.options,
        "Состав набора изменился. Проверьте параметры и обновите предпросмотр.");
    } else {
      errorNode.textContent = error.message;
    }
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
function updateSubmissionForm(target) {
  const form = target.closest("#submission-form");
  if (!form) return;
  const group = form.elements.group_id;
  group.setCustomValidity("");
  if (target.name === "dataset" && (!group.value.trim() || group.value.trim() === state.submissionOptions.dataset))
    group.value = target.value;
  state.submissionOptions = submissionOptions(form);
  submissionRequest++;
  submissionSnapshot = null;
  form.querySelector('[type="submit"]').disabled = false;
  root.querySelector("#submission-result").innerHTML = submissionEmpty(true);
}
function rememberJob(id) {
  try {
    if (id) sessionStorage.setItem("cqa-active-job", id);
    else sessionStorage.removeItem("cqa-active-job");
  } catch {}
}
function updateAssessmentControls() {
  const action = root.querySelector("[data-action=evaluate-one]");
  if (!action || !state.detail) return;
  action.disabled = Boolean(state.job) || !state.ai?.configured || !evaluationTextSource(state);
  const label = assessmentAction(state);
  if (action.textContent !== label) action.lastChild.textContent = label;
  const basis = root.querySelector("#assessment-basis");
  const content = assessmentBasis(state);
  if (basis && basis.innerHTML !== content) basis.innerHTML = content;
}
function updateJob() {
  const region = root.querySelector("#feed-job");
  if (!region) return;
  const progress = region.querySelector("progress");
  if (progress && state.job) {
    progress.max = state.job.total || 1;
    progress.value = state.job.done;
    region.querySelector(".caption-3").textContent = `${state.job.done} / ${state.job.total}`;
  } else {
    region.innerHTML = jobProgress(state.job);
  }
  updateAssessmentControls();
  const batch = root.querySelector("[data-action=evaluate-all]");
  if (batch) batch.disabled = Boolean(state.job) || !state.ai?.configured || !datasetRows(state).length;
}
async function refreshAfterJob() {
  if (["checklist", "submission"].includes(state.route)) return summary();
  if (!isWorkspace()) return loadPage({ refresh: true });
  const token = routeToken;
  const detail = state.detail;
  const pinned = routeInfo().evaluationId;
  await summary();
  if (token !== routeToken) return;
  updateFeed();
  if (detail && !pinned) {
    const evaluation = await api.evaluation(detail.conversation.conversation_id, detail.checklist.id)
      .catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
    if (token !== routeToken) return;
    state.detail = { ...detail, evaluation };
    if (!state.drawer) root.querySelector(".cqa-audit").innerHTML = scorecard(state);
  }
}
async function pollJob(id) {
  try {
    while (true) {
      const job = await api.job(id);
      state.job = job;
      if (["done", "error"].includes(job.status)) {
        state.job = null;
        rememberJob(null);
        updateJob();
        await refreshAfterJob();
        toast(
          job.status === "done"
            ? `Оценка завершена. Обработано диалогов: ${job.done}`
            : job.errors?.[0]?.error || "Часть диалогов не удалось оценить",
          job.status === "done" ? "success" : "error",
        );
        return;
      }
      updateJob();
      await new Promise((r) => setTimeout(r, 750));
    }
  } catch (error) {
    state.job = null;
    if (error.status === 404) rememberJob(null);
    updateJob();
    toast(error.message, "error");
  }
}
async function evaluate(one = false) {
  if (state.job || !state.ai?.configured || (one && !state.detail)) return;
  const source = one ? evaluationTextSource(state) : "original";
  if (!source) return;
  const ids = one ? [state.detail.conversation.conversation_id] : datasetRows(state).map((c) => c.conversation_id);
  if (!ids.length) return;
  const version = one ? state.detail.checklist.id : state.version;
  const token = routeToken;
  state.job = { done: 0, total: ids.length };
  updateJob();
  try {
    const { job_id } = await api.evaluate(ids, version, source);
    if (one && token === routeToken) {
      history.replaceState(null, "", `#dialog/${encodeURIComponent(ids[0])}?version=${encodeURIComponent(version)}`);
      state.route = "dialog";
    }
    rememberJob(job_id);
    await pollJob(job_id);
  } catch (error) {
    state.job = null;
    const stale = error.status === 409 && source === "gemini";
    if (stale && token === routeToken) state.transcriptionStale = true;
    updateJob();
    toast(stale ? "Расшифровка Gemini отсутствует или устарела. Обновите диалог." : error.message, "error");
  }
}
function highlightEvidence(from, to = from) {
  const messages = state.detail?.conversation.messages || [];
  const start = messages.findIndex((m) => m.id === from),
    end = messages.findIndex((m) => m.id === to);
  if (start < 0 || end < start) return;
  root
    .querySelectorAll("[data-message]")
    .forEach((node) => node.classList.remove("is-highlighted"));
  for (const m of messages.slice(start, end + 1))
    root
      .querySelector(`#message-${CSS.escape(m.id)}`)
      ?.classList.add("is-highlighted");
  const target = root.querySelector(`#message-${CSS.escape(from)}`);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target?.scrollIntoView({
    block: "center",
    behavior: reduced ? "instant" : "smooth",
  });
  target?.focus({ preventScroll: true });
  const audio = root.querySelector("#conversation-audio");
  const offset = messages[start].offset_sec;
  if (audio && Number.isFinite(offset) && offset >= 0) {
    if (audio.readyState) audio.currentTime = offset;
    else audio.onloadedmetadata = () => { audio.currentTime = offset; };
  }
}
root.addEventListener("click", (event) => {
  const target = event.target.closest("button,a,tr");
  if (!target || target.disabled) return;
  if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    root.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
    updateFeed();
    return;
  }
  if (target.dataset.adjacent) {
    const rows = feedRows(state);
    const index = rows.findIndex((c) => c.conversation_id === state.selected);
    const next = rows[index + Number(target.dataset.adjacent)];
    if (next) navigate(next.conversation_id);
    return;
  }
  if (target.dataset.role) {
    if (state.role === target.dataset.role) return;
    state.role = target.dataset.role;
    root.querySelectorAll("[data-role]").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
    const score = root.querySelector(".cqa-audit");
    if (!state.drawer && score && state.detail && !state.error)
      score.innerHTML = scorecard(state);
    return;
  }
  if (target.dataset.transcript) {
    state.textMode = target.dataset.transcript;
    updateTranscript(true);
    return;
  }
  if (target.dataset.editor) {
    editChecklist(target, state.checklist.sections);
    return;
  }
  if (target.dataset.open) {
    navigate(target.dataset.open);
    return;
  }
  if (target.dataset.dialog && !event.target.closest("button,a")) {
    navigate(target.dataset.dialog);
    return;
  }
  if (target.dataset.evidence) {
    highlightEvidence(target.dataset.evidence);
    return;
  }
  if (target.dataset.rangeFrom) {
    highlightEvidence(target.dataset.rangeFrom, target.dataset.rangeTo);
    return;
  }
  if (target.dataset.appeal) {
    openAppeal(target.dataset.appeal);
    return;
  }
  if (target.dataset.review) {
    openReview(target.dataset.review);
    return;
  }
  if (target.dataset.appealFilter) {
    state.appealFilter = target.dataset.appealFilter;
    render();
    return;
  }
  switch (target.dataset.action) {
    case "skip-main":
      event.preventDefault();
      root.querySelector("#main-content")?.focus();
      break;
    case "import":
      openImport();
      break;
    case "close-modal":
      root.querySelector("#cqa-modal").close();
      break;
    case "refresh":
      loadPage({ refresh: true });
      break;
    case "checklist-drawer":
      toggleDrawer(target);
      break;
    case "transcribe":
      if (!state.ai?.transcription_configured || !state.detail ||
          ["loading", "running", "done"].includes(state.transcription?.status)) break;
      state.transcription = { status: "running" };
      updateTranscript();
      readTranscription(state.detail.conversation.conversation_id, routeToken, true);
      break;
    case "reset-filters":
      state.search = "";
      state.filter = "all";
      root.querySelector("#dialog-search").value = "";
      root.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === "all")));
      updateFeed();
      break;
    case "download-submission":
      downloadSubmission(target);
      break;
    case "evaluate-all":
      evaluate();
      break;
    case "evaluate-one":
      evaluate(true);
      break;
  }
});
root.addEventListener("input", (event) => {
  if (event.target.name === "group_id") updateSubmissionForm(event.target);
  if (event.target.id === "dialog-search") {
    state.search = event.target.value;
    updateFeed();
  }
});
root.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.id === "audio-speed") root.querySelector("#conversation-audio").playbackRate = Number(target.value);
  if (target.id === "version-select" || target.id === "drawer-version") {
    state.version = Number(target.value);
    if (state.route === "checklist" || target.id === "drawer-version") await loadPage();
    else if (state.detail) location.hash = `dialog/${encodeURIComponent(state.selected)}?version=${encodeURIComponent(state.version)}`;
  }
  if (target.id === "detail-version")
    location.hash = `dialog/${encodeURIComponent(state.detail.conversation.conversation_id)}?version=${encodeURIComponent(target.value)}`;
  if (target.id === "review-action")
    root.querySelector("#review-change").hidden = target.value !== "change";
  if (target.tagName === "SELECT") updateSubmissionForm(target);
  updateCriterionControls(target);
});
root.addEventListener("error", (event) => {
  if (event.target.id === "conversation-audio") {
    const error = root.querySelector("#audio-error");
    if (error) error.hidden = false;
  }
}, true);
root.addEventListener("submit", (event) => {
  if (event.target.id === "dataset-form") {
    event.preventDefault();
    openDataset(event.target);
  }
  if (event.target.id === "submission-form") {
    event.preventDefault();
    previewSubmission(event.target);
  }
  if (event.target.id === "modal-form") {
    event.preventDefault();
    submitModal(event.target);
  }
  if (event.target.id === "checklist-form") {
    event.preventDefault();
    saveChecklist(event.target);
  }
});
window.addEventListener("hashchange", () => loadPage({ focus: true }));
window.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !root.querySelector("dialog[open]")
  ) {
    const input = root.querySelector("#dialog-search");
    if (input) {
      event.preventDefault();
      input.focus();
    }
  }
});
async function main() {
  render();
  try {
    await loadPage({ refresh: true });
    let job;
    try {
      job = sessionStorage.getItem("cqa-active-job");
    } catch {}
    if (job) pollJob(job);
  } catch (error) {
    state.loading = false;
    state.error = error.message;
    render();
  }
}
main();
