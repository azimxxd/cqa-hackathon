// Owner: Нурлат. Placeholder screen that proves the API wiring; replace with real views/.
import { api } from './api.js';

const root = document.getElementById('cqa-root');

async function main() {
  const list = await api.conversations();
  root.innerHTML = `
    <h1 class="cqa-title">Диалоги</h1>
    <ul class="cqa-list">
      ${list.map((c) => `<li>${c.conversation_id} · ${c.channel} · ${c.language} · итог ${c.total ?? '—'}</li>`).join('')}
    </ul>`;
}

main().catch((err) => { root.textContent = `Ошибка: ${err.message}`; });
