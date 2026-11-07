import { escape as e } from "./ui.js";

const field = (label, control) =>
  `<label class="cqa-field"><span class="caption-2 cqa-muted">${label}</span>${control}</label>`;
const checkbox = (name, label, checked) =>
  `<label class="cqa-checkbox body-6"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}>${label}</label>`;

export function scaleRow({ value = "", label = "" } = {}) {
  return `<div class="cqa-form-grid cqa-scale-row" data-scale-row>
    ${field("Значение", `<input name="scale-value" type="number" min="0" step="any" value="${e(value)}" required>`)}
    ${field("Подпись", `<input name="scale-label" value="${e(label)}" required>`)}
    <button class="cqa-button cqa-secondary button-sm" type="button" data-editor="delete-scale">Удалить значение</button>
  </div>`;
}

export function criterionEditor(c, sections) {
  return `<fieldset class="cqa-panel cqa-editor-row" data-criterion="${e(c.id)}">
    <legend class="cqa-sr-only">Критерий ${e(c.id)}</legend>
    <div class="cqa-editor-number caption-3">${e(c.id)}</div>
    <div class="cqa-editor-main">
      ${field("Критерий", `<input name="title" value="${e(c.title)}" required>`)}
      ${field("Описание", `<textarea name="description" rows="3" required>${e(c.description)}</textarea>`)}
      <div class="cqa-form-grid">
        ${field("Раздел", `<select name="section">${sections.map((s) => `<option value="${e(s.id)}" ${s.id === c.section ? "selected" : ""}>${e(s.title)}</option>`).join("")}</select>`)}
        ${field("Тип", `<select name="type"><option value="binary" ${c.type === "binary" ? "selected" : ""}>Да / Нет</option><option value="scale" ${c.type === "scale" ? "selected" : ""}>Шкала</option></select>`)}
        ${field("Вес", `<input type="number" name="weight" min="0" step="any" value="${e(c.weight)}" required>`)}
      </div>
      <div class="cqa-editor-flags">
        ${checkbox("na_allowed", "Разрешить «Не применимо»", c.na_allowed)}
        ${checkbox("scores_points", "Начислять баллы", c.scores_points)}
        ${checkbox("gross_error", "Грубая ошибка", c.gross_error)}
      </div>
      ${field("Когда критерий не применяется", `<input name="na_condition" value="${e(c.na_condition ?? "")}" ${c.na_allowed ? "required" : ""}>`)}
      <fieldset class="cqa-scale-editor" data-scale ${c.type === "scale" ? "" : "hidden disabled"}>
        <legend class="title-4">Значения шкалы</legend>
        <div data-scale-rows>${(c.scale ?? []).map(scaleRow).join("")}</div>
        <button class="cqa-button cqa-secondary button-sm" type="button" data-editor="add-scale">Добавить значение</button>
      </fieldset>
      <div><button class="cqa-button cqa-secondary button-sm" type="button" data-editor="delete-criterion">Удалить критерий</button></div>
    </div>
  </fieldset>`;
}

export function newCriterion(sections, id = `criterion-${crypto.randomUUID()}`) {
  return { id, section: sections[0]?.id, title: "", description: "", type: "binary",
    weight: 0, na_allowed: false, na_condition: null, scores_points: true, scale: null };
}

export function serializeCriterion(original, fields, scale) {
  const c = { ...original, ...fields, title: fields.title.trim(),
    weight: Number(fields.weight), na_condition: fields.na_condition || null,
    scale: fields.type === "scale" ? scale.map(({ value, label }) => ({ value: Number(value), label })) : null };
  if (!c.gross_error && original.gross_error === undefined) delete c.gross_error;
  if (!c.title) throw Error(`Укажите название критерия ${c.id}.`);
  if (c.na_allowed && !c.na_condition?.trim())
    throw Error(`Укажите условие «Не применимо» для критерия «${c.title}».`);
  if (c.type === "scale" && (!c.scale.some((p) => p.value > 0) ||
      new Set(c.scale.map((p) => p.value)).size !== c.scale.length ||
      c.scale.some((p) => !Number.isFinite(p.value) || p.value < 0 || !p.label.trim())))
    throw Error(`Для «${c.title}» задайте уникальные значения шкалы, включая положительное, и подпись к каждому.`);
  return c;
}

export function readChecklist(form, original) {
  const name = form.elements.name.value.trim();
  const criteria = [...form.querySelectorAll("[data-criterion]")].map((row) => {
    const id = row.dataset.criterion;
    const value = (name) => row.querySelector(`[name="${name}"]`).value;
    const checked = (name) => row.querySelector(`[name="${name}"]`).checked;
    const previous = original.criteria.find((c) => c.id === id) ?? { id };
    const scale = [...row.querySelectorAll("[data-scale-row]")].map((point) => ({
      value: point.querySelector('[name="scale-value"]').value,
      label: point.querySelector('[name="scale-label"]').value,
    }));
    return serializeCriterion(previous, {
      title: value("title"), description: value("description"), section: value("section"),
      type: value("type"), weight: value("weight"), na_condition: value("na_condition"),
      na_allowed: checked("na_allowed"), scores_points: checked("scores_points"),
      gross_error: checked("gross_error"),
    }, scale);
  });
  if (!criteria.length) throw Error("Добавьте хотя бы один критерий.");
  if (!name) throw Error("Укажите название чек-листа.");
  return { ...original, name,
    first_reaction_threshold_sec: Number(form.elements.threshold.value), criteria };
}

export function editChecklist(target, sections) {
  const form = target.closest("form");
  const criterion = target.closest("[data-criterion]");
  switch (target.dataset.editor) {
    case "add-criterion": {
      const list = form.querySelector("[data-criteria]");
      list.insertAdjacentHTML("beforeend", criterionEditor(newCriterion(sections), sections));
      list.lastElementChild.querySelector('[name="title"]').focus();
      break;
    }
    case "delete-criterion":
      criterion.remove();
      form.querySelector('[data-editor="add-criterion"]').focus();
      break;
    case "add-scale": {
      const list = criterion.querySelector("[data-scale-rows]");
      list.insertAdjacentHTML("beforeend", scaleRow());
      list.lastElementChild.querySelector("input").focus();
      break;
    }
    case "delete-scale":
      target.closest("[data-scale-row]").remove();
      criterion.querySelector('[data-editor="add-scale"]').focus();
      break;
  }
}

export function updateCriterionControls(target) {
  const row = target.closest("[data-criterion]");
  if (!row) return;
  if (target.name === "type") {
    const scale = row.querySelector("[data-scale]");
    scale.hidden = scale.disabled = target.value !== "scale";
  }
  if (target.name === "na_allowed")
    row.querySelector('[name="na_condition"]').required = target.checked;
}
