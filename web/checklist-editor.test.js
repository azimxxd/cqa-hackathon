import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { criterionEditor, newCriterion, readChecklist, serializeCriterion, updateCriterionControls } from "./checklist-editor.js";

const official = JSON.parse(readFileSync(new URL("../shared/checklist.default.json", import.meta.url)));
const sections = official.sections;
const c = official.criteria[3];

test("type switching disables inactive inputs while preserving the scale draft", () => {
  const draft = { value: "13", label: "Черновик" };
  const scale = { draft };
  const row = { querySelector: () => scale };
  const target = { closest: () => row, name: "type", value: "binary" };
  updateCriterionControls(target);
  assert.equal(scale.hidden, true);
  assert.equal(scale.disabled, true);
  assert.equal(serializeCriterion(c, { ...c, type: "binary" }, [draft]).scale, null);
  target.value = "scale";
  updateCriterionControls(target);
  assert.equal(scale.disabled, false);
  assert.deepEqual(serializeCriterion(c, c, [scale.draft]).scale, [{ value: 13, label: "Черновик" }]);
});

test("serialization keeps untouched official fields and rejects invalid scales", () => {
  for (const criterion of official.criteria)
    assert.deepEqual(serializeCriterion(criterion, { ...criterion }, criterion.scale), criterion);
  assert.throws(() => serializeCriterion(c, c, [{ value: 0, label: "Ноль" }]), /положительное/);
  assert.throws(() => serializeCriterion(c, c, [{ value: 4, label: "A" }, { value: 4, label: "B" }]), /уникальные/);
});

test("save serializes only remaining criteria, preserving IDs and newly edited fields", () => {
  const added = newCriterion(sections);
  assert.notEqual(added.id, newCriterion(sections).id);
  assert.doesNotMatch(criterionEditor(added, sections), /<option value="undefined"/);
  const fields = {
    ...added, section: sections[1].id, type: "scale", title: "Новый критерий",
    description: "Описание", weight: "12.5", na_allowed: true, na_condition: "Условие",
    scores_points: false, gross_error: true,
  };
  const form = {
    elements: { name: { value: "Новая версия" }, threshold: { value: "180" } },
    querySelectorAll: () => [{
      dataset: { criterion: added.id },
      querySelector: (selector) => {
        const name = selector.split('"')[1];
        return { value: fields[name], checked: fields[name] };
      },
      querySelectorAll: () => [{
        querySelector: (selector) => ({ value: selector.includes("scale-value") ? "4.5" : "Выполнено" }),
      }],
    }],
  };
  assert.deepEqual(readChecklist(form, official).criteria, [{
    ...fields, weight: 12.5, scale: [{ value: 4.5, label: "Выполнено" }],
  }]);
  assert.equal(official.criteria.length, 8);
});
