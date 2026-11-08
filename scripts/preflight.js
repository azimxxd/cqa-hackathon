// Readiness only: no import, evaluation, model generation, or export.
import { openDatabase } from '../server/db.js';
import { evaluationConfig } from '../ai/config.js';
import { submissionChecklist, controlModel } from './control-config.js';
import { probe, ollamaUrl, ollamaHeaders } from '../ai/router.js';

const db = openDatabase();
try {
  const checklist = submissionChecklist(db);
  const model = await controlModel();
  const config = evaluationConfig();
  console.log(JSON.stringify({ official_checklist_version: checklist.id, model, samples: config.samples,
    organizer_api_configured: Boolean(process.env.ORG_API_URL), fake: false }, null, 2));
  if (model.startsWith('ollama/')) {
    if (!await probe()) throw Error('Ollama is unavailable or the configured model is missing');
    const response = await fetch(`${ollamaUrl()}/api/ps`, { headers: ollamaHeaders(), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`Ollama readiness HTTP ${response.status}`);
    const running = await response.json();
    const loaded = (running.models || []).some(m => (m.name || m.model) === model.slice(7));
    console.log(`Ollama responds; model ${loaded ? 'is loaded' : 'is NOT loaded: warm it up before the control hour'}.`);
    if (!loaded) process.exitCode = 1;
  } else {
    const key = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY).split(/[\s,;]+/).find(Boolean);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw Error(`Gemini model availability HTTP ${response.status}; check the model name and API key`);
    console.log('Gemini model metadata is accessible. Generation quota and semantic quality still require a live rehearsal.');
  }
  if (!process.env.ORG_API_URL) console.log('No organizer URL: use --input with the original JSON supplied by the organizers.');
} catch (error) {
  console.error(`[preflight] ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
