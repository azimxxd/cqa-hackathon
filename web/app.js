import { api } from "./api.js";
import { escape as e, icon, button, emptyState, skeleton, time } from "./ui.js";
import {
  dialogsPage,
  dialogTable,
  detailPage,
  appealsPage,
  checklistPage,
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
  channel: "",
  status: "",
  appealFilter: "open",
  detail: null,
  checklist: null,
  loading: true,
  error: null,
  job: null,
  notice: null,
  modal: null,
};
let routeToken = 0,
  noticeTimer;
const nav = [
  ["dialogs", "chats", "Диалоги"],
  ["appeals", "scales", "Апелляции"],
  ["checklist", "list-checks", "Чек-лист"],
  ["stats", "chart-bar", "Статистика"],
];
function render() {
  const active = state.route === "dialog" ? "dialogs" : state.route;
  document.title = `${state.route === "dialog" && state.detail ? state.detail.conversation.conversation_id : nav.find((n) => n[0] === active)?.[2] || "Страница не найдена"} · CQA`;
  let content;
  if (state.loading) content = skeleton();
  else if (state.error)
    content = `<div class="cqa-page-error" role="alert">${emptyState("Не удалось загрузить данные", state.error, button("Попробовать снова", "refresh", "arrow-clockwise", true))}</div>`;
  else
    content = (
      {
        dialogs: dialogsPage,
        dialog: detailPage,
        appeals: appealsPage,
        checklist: checklistPage,
        stats: statsPage,
      }[state.route] ||
      (() =>
        emptyState(
          "Страница не найдена",
          "Вернитесь к списку диалогов.",
          `<a class="cqa-button cqa-primary button-sm" href="#dialogs">К диалогам</a>`,
        ))
    )(state);
  const count = state.appeals.filter((a) => a.status === "open").length;
  root.innerHTML = `<a class="cqa-skip button-sm" href="#main-content" data-action="skip-main">Перейти к содержимому</a><div class="cqa-shell"><aside class="cqa-sidebar"><a class="cqa-brand" href="#dialogs" aria-label="CQA, к диалогам"><span class="cqa-brand-mark"><i></i><i></i><i></i></span><span class="cqa-brand-word heading-5">cqa<span>.</span></span></a><div class="cqa-workspace-name"><span class="caption-3">Freedom Broker</span><span class="caption-5">Качество общения</span></div><nav aria-label="Основная навигация">${nav.map(([id, glyph, label]) => `<a href="#${id}" class="cqa-nav-link title-4 ${active === id ? "is-active" : ""}" ${active === id ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span>${id === "appeals" && count ? `<span class="cqa-nav-count caption-4">${count}</span>` : ""}</a>`).join("")}</nav><div class="cqa-sidebar-bottom"><div class="cqa-sidebar-note">${icon("list-checks")}<p class="caption-5">Каждый вывод<br>подтверждается диалогом</p></div><div class="cqa-sidebar-footer"><span class="cqa-team-avatar caption-3">QA</span><div><p class="title-5">Рабочее пространство</p><p class="caption-5">Контроль качества</p></div></div></div></aside><div class="cqa-workspace"><header class="cqa-topbar"><div class="cqa-breadcrumb caption-2"><span>Рабочее пространство</span>${icon("caret-right")}<span>${nav.find((n) => n[0] === active)?.[2] || "Страница"}</span></div><a class="cqa-topbar-brand caption-3" href="#dialogs"><span class="cqa-small-dot"></span>Freedom Broker</a></header><main class="cqa-main" id="main-content" tabindex="-1">${content}</main></div></div><div class="cqa-toast body-6 ${state.notice ? "is-visible" : ""}" role="status" data-tone="${state.notice?.tone || "success"}">${icon(state.notice?.tone === "error" ? "warning-circle" : "check-circle")}<span>${e(state.notice?.message || "")}</span></div><dialog id="cqa-modal" class="cqa-modal" aria-labelledby="modal-title"></dialog>`;
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
async function summary() {
  const [conversations, versions, stats, appeals] = await Promise.all([
    api.conversations(),
    api.checklists(),
    api.stats(),
    api.appeals(),
  ]);
  Object.assign(state, { conversations, versions, stats, appeals });
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
    };
  return { page: path };
}
async function loadPage(options = {}) {
  const token = ++routeToken;
  let route;
  try {
    route = routeInfo();
  } catch {
    route = { page: "missing" };
  }
  state.route = route.page;
  state.loading = true;
  state.error = null;
  render();
  try {
    if (options.refresh) await summary();
    if (route.page === "dialog") {
      const conversation = await api.conversation(route.id);
      const version = options.version || route.version;
      const evaluationId = options.evaluationId || route.evaluationId;
      const evaluation = evaluationId
        ? await api.evaluationById(evaluationId)
        : await api.evaluation(route.id, version).catch((error) => {
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
    } else if (route.page === "checklist") {
      const checklist = await api.checklist(state.version);
      if (token !== routeToken) return;
      state.checklist = checklist;
    }
    if (token !== routeToken) return;
    state.loading = false;
    render();
    if (options.focus) {
      window.scrollTo({ top: 0, behavior: "instant" });
      root.querySelector("#page-title")?.focus({ preventScroll: true });
    }
  } catch (error) {
    if (token !== routeToken) return;
    state.loading = false;
    state.error = error.message;
    render();
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
    `<p class="body-6 cqa-muted">Укажите группу данных организаторов. Уже импортированные диалоги сохранят свои оценки.</p><label class="cqa-field"><span class="title-4">ID группы</span><input name="group" placeholder="Например, DEV" required autocomplete="off"></label>${modalActions("Импортировать")}`,
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
  try {
    const evaluation = await api.evaluationById(appeal.evaluation_id);
    if (appeal.status === "decided") {
      location.hash = `dialog/${encodeURIComponent(evaluation.conversation_id)}?evaluation=${evaluation.id}`;
      return;
    }
    const [checklist, conversation] = await Promise.all([
      api.checklist(evaluation.checklist_version_id),
      api.conversation(evaluation.conversation_id),
    ]);
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
      const r = await api.importGroup(data.get("group").trim());
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
    const data = new FormData(form),
      body = structuredClone(state.checklist);
    body.name = data.get("name").trim();
    body.first_reaction_threshold_sec = Number(data.get("threshold"));
    body.criteria = body.criteria.map((c) => ({
      ...c,
      title: data.get(`title:${c.id}`).trim(),
      description: data.get(`description:${c.id}`),
      weight: Number(data.get(`weight:${c.id}`)),
      na_allowed: data.has(`na:${c.id}`),
      na_condition: data.get(`condition:${c.id}`) || null,
    }));
    for (const c of body.criteria)
      if (c.na_allowed && !c.na_condition?.trim())
        throw Error(
          `Укажите условие «Не применимо» для критерия «${c.title}».`,
        );
    const saved = await api.saveChecklist(body);
    state.version = saved.id;
    await loadPage({ refresh: true });
    toast(`Версия ${saved.id} сохранена. Предыдущие оценки доступны в истории`);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.scrollIntoView({ block: "center" });
    submit.disabled = false;
  }
}
function rememberJob(id) {
  try {
    if (id) sessionStorage.setItem("cqa-active-job", id);
    else sessionStorage.removeItem("cqa-active-job");
  } catch {}
}
async function pollJob(id) {
  try {
    while (true) {
      const job = await api.job(id);
      state.job = job;
      if (["done", "error"].includes(job.status)) {
        state.job = null;
        rememberJob(null);
        await loadPage({ refresh: true });
        toast(
          job.status === "done"
            ? `Оценка завершена. Обработано диалогов: ${job.done}`
            : job.errors[0]?.error || "Часть диалогов не удалось оценить",
          job.status === "done" ? "success" : "error",
        );
        return;
      }
      if (state.route === "dialogs" && !root.querySelector("dialog[open]")) {
        const progress = root.querySelector(".cqa-job progress");
        if (progress) {
          progress.max = job.total || 1;
          progress.value = job.done;
          root.querySelector(".cqa-job .caption-3").textContent =
            `${job.done} / ${job.total}`;
        } else render();
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  } catch (error) {
    state.job = null;
    if (error.status === 404) rememberJob(null);
    await loadPage({ refresh: true });
    toast(error.message, "error");
  }
}
async function evaluate(one = false) {
  if (state.job) return;
  const ids = one ? [state.detail.conversation.conversation_id] : "all";
  const version = one ? state.detail.checklist.id : state.version;
  if (one)
    history.replaceState(
      null,
      "",
      `#dialog/${encodeURIComponent(state.detail.conversation.conversation_id)}?version=${version}`,
    );
  state.job = { done: 0, total: one ? 1 : state.conversations.length };
  render();
  try {
    const { job_id } = await api.evaluate(ids, version);
    rememberJob(job_id);
    await pollJob(job_id);
  } catch (error) {
    state.job = null;
    render();
    toast(error.message, "error");
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
  if (audio) {
    const seek = () => {
      audio.currentTime = messages[start].offset_sec;
    };
    if (audio.readyState) seek();
    else audio.addEventListener("loadedmetadata", seek, { once: true });
  }
}
root.addEventListener("click", (event) => {
  const target = event.target.closest("button,a,tr");
  if (!target || target.disabled) return;
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
    case "reset-filters":
      state.search = state.channel = state.status = "";
      render();
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
  if (event.target.id === "dialog-search") {
    state.search = event.target.value;
    root.querySelector("#dialog-table").innerHTML = dialogTable(state);
  }
});
root.addEventListener("change", async (event) => {
  const target = event.target;
  if (["channel-filter", "status-filter"].includes(target.id)) {
    state[target.id === "channel-filter" ? "channel" : "status"] = target.value;
    root.querySelector("#dialog-table").innerHTML = dialogTable(state);
  }
  if (target.id === "version-select") {
    state.version = Number(target.value);
    if (state.route === "checklist") await loadPage();
  }
  if (target.id === "detail-version")
    location.hash = `dialog/${encodeURIComponent(state.detail.conversation.conversation_id)}?version=${encodeURIComponent(target.value)}`;
  if (target.id === "review-action")
    root.querySelector("#review-change").hidden = target.value !== "change";
  if (target.dataset.na)
    root.querySelector(
      `[name="${CSS.escape(`condition:${target.dataset.na}`)}"]`,
    ).required = target.checked;
});
root.addEventListener("submit", (event) => {
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
    await summary();
    await loadPage();
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
