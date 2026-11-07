// Owner: Нурлат. All HTTP calls go through here; shapes are in shared/schemas.md.
import { API_BASE } from './config.js';

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  conversations: () => request('GET', '/conversations'),
  conversation: (id) => request('GET', `/conversations/${encodeURIComponent(id)}`),
  checklist: (id = 'latest') => request('GET', `/checklists/${id}`),
  evaluation: (conversationId) => request('GET', `/evaluations?conversation_id=${encodeURIComponent(conversationId)}`),
};
