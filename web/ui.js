export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const icon = (name, extra = "") =>
  `<svg class="cqa-icon ${extra}" aria-hidden="true"><use href="./assets/icons.svg#${name}"></use></svg>`;
export const number = (value, digits = 0) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(
    value,
  );
export const score = (value) => (value == null ? "—" : number(value, 2));
export const money = (value) =>
  `$${Number(value || 0)
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}`;
export const plural = (n, forms) =>
  forms[
    n % 100 >= 11 && n % 100 <= 14
      ? 2
      : n % 10 === 1
        ? 0
        : n % 10 >= 2 && n % 10 <= 4
          ? 1
          : 2
  ];
export const messageCount = (n) =>
  `${number(n)} ${plural(n, ["реплика", "реплики", "реплик"])}`;
export const formatDate = (value) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";
export const time = (seconds) =>
  `${String(Math.floor((seconds || 0) / 60)).padStart(2, "0")}:${String(Math.floor((seconds || 0) % 60)).padStart(2, "0")}`;
export const statusLabel = (status) =>
  ({
    done: "Оценён",
    error: "Ошибка оценки",
    running: "Оценивается",
    queued: "В очереди",
  })[status] || "Не оценён";
export function statusBadge(status) {
  const symbol =
    {
      done: "check-circle",
      error: "warning-circle",
      running: "clock",
      queued: "clock",
    }[status] || "circle-notch";
  return `<span class="cqa-badge cqa-status-${["done", "error", "running", "queued"].includes(status) ? status : "empty"} caption-4">${icon(symbol)}${statusLabel(status)}</span>`;
}
export function emptyState(title, description, action = "") {
  return `<div class="cqa-empty">${icon("chats", "cqa-empty-icon")}<h2 class="heading-5">${escape(title)}</h2><p class="body-6">${escape(description)}</p>${action}</div>`;
}
export function skeleton() {
  return `<div class="cqa-skeleton" aria-label="Загрузка" aria-busy="true"><div></div><div></div><div></div><div></div></div>`;
}
export function button(label, action, glyph = "", primary = false, extra = "") {
  return `<button type="button" class="cqa-button ${primary ? "cqa-primary" : "cqa-secondary"} button-sm" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${escape(label)}</button>`;
}
export function safeAudio(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
