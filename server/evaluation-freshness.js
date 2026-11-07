import { createHash } from 'node:crypto';
import { configHash } from '../ai/config.js';
export const messageHash = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
export function evaluationIsCurrent(row, { model, promptVersion, config, checklist, conversation }) {
  if (!row || row.status !== 'done' || row.model !== model) return false;
  let data;
  try { data = JSON.parse(row.data); } catch { return false; }
  return data.config_id === configHash(config) &&
    data.prompt_key === `${promptVersion}|frt=${checklist.first_reaction_threshold_sec ?? 180}` &&
    data.transcript_source === 'original' && data.transcript_hash === messageHash(conversation.messages);
}
