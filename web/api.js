import { API_BASE } from "./config.js";

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
async function request(method, path, body, asBlob = false) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.",
      0,
    );
  }
  if (asBlob && res.ok) return res.blob();
  const data = await res.json().catch(() => null);
  if (!res.ok)
    throw new ApiError(
      data?.error || "Не удалось выполнить запрос. Попробуйте ещё раз.",
      res.status,
      data,
    );
  if (data === null)
    throw new ApiError(
      "Сервер вернул некорректный ответ. Попробуйте обновить страницу.",
      res.status,
    );
  return data;
}
const encoded = encodeURIComponent;
export const api = {
  submissionPreview: (params) => request("GET", `/submission/preview?${new URLSearchParams(params)}`),
  submissionDownload: (params) => request("GET", `/submission/download?${new URLSearchParams(params)}`, undefined, true),
  conversations: () => request("GET", "/conversations"),
  conversation: (id) => request("GET", `/conversations/${encoded(id)}`),
  checklists: () => request("GET", "/checklists"),
  checklist: (id = "latest") => request("GET", `/checklists/${encoded(id)}`),
  saveChecklist: (body) => request("POST", "/checklists", body),
  evaluation: (id, version) =>
    request(
      "GET",
      `/evaluations?conversation_id=${encoded(id)}${version ? `&version=${encoded(version)}` : ""}`,
    ),
  evaluationById: (id) => request("GET", `/evaluations/${encoded(id)}`),
  importGroup: (group_id) => request("POST", "/import", { group_id }),
  evaluate: (conversation_ids, checklist_version_id) =>
    request("POST", "/evaluate", { conversation_ids, checklist_version_id }),
  job: (id) => request("GET", `/jobs/${encoded(id)}`),
  stats: () => request("GET", "/stats"),
  appeals: () => request("GET", "/appeals"),
  appeal: (body) => request("POST", "/appeals", body),
  decide: (id, body) =>
    request("POST", `/appeals/${encoded(id)}/decision`, body),
};
