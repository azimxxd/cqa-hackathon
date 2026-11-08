import { getChecklist } from '../server/db.js';
import { officialChecklist } from '../shared/submission.js';
import { autoMode, loadRegisteredEndpoint, probe, activeProvider } from '../ai/router.js';
import { modelName } from '../ai/evaluate.js';

// Jury edits must not silently become the checklist for an official submission.
export function submissionChecklist(db, requested) {
  if (requested !== undefined) {
    const id = Number(requested);
    if (!Number.isSafeInteger(id) || id < 1) throw Error('Invalid checklist_version_id');
    const checklist = getChecklist(db, id);
    if (!checklist) throw Error('Unknown checklist version');
    if (!officialChecklist(checklist))
      throw Error('Checklist is not compatible with official submission; use an official version, not the jury demo rules');
    return checklist;
  }
  for (const { id } of db.prepare('SELECT id FROM checklist_versions ORDER BY id DESC').all()) {
    const checklist = getChecklist(db, id);
    if (officialChecklist(checklist)) return checklist;
  }
  throw Error('No official checklist version found; restore the official checklist before the control run');
}

export async function controlModel() {
  const mode = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (!['gemini', 'ollama', 'auto'].includes(mode)) throw Error('Unknown LLM_PROVIDER');
  if (process.env.CQA_FAKE_LLM === '1') throw Error('Test provider cannot produce a submission');
  // CLI runs do not start the web server's background router. Probe explicitly.
  if (autoMode()) {
    loadRegisteredEndpoint();
    await probe();
  }
  if (activeProvider() === 'gemini' && !(process.env.GEMINI_API_KEYS?.trim() || process.env.GEMINI_API_KEY?.trim()))
    throw Error('Gemini is selected but no API key is configured');
  return modelName();
}
