import { createHash } from 'node:crypto';
export function sampleCount(value) {
  const n = Number(value ?? process.env.LLM_SAMPLES ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}
export function evaluationConfig(input = {}) {
  const config = {
    revision: 1,
    samples: sampleCount(input.samples),
    sampleTemperature: Number(input.sampleTemperature ?? process.env.LLM_SAMPLE_TEMPERATURE ?? 0.7),
    ollamaThink: input.ollamaThink ?? process.env.OLLAMA_THINK === '1',
    ollamaNumCtx: Number(input.ollamaNumCtx ?? process.env.OLLAMA_NUM_CTX ?? 16384),
    geminiThinkingBudget: input.geminiThinkingBudget !== undefined ? input.geminiThinkingBudget :
      process.env.GEMINI_THINKING_BUDGET?.trim() ? Number(process.env.GEMINI_THINKING_BUDGET) : null,
  };
  if (!Number.isFinite(config.sampleTemperature) || config.sampleTemperature < 0 || config.sampleTemperature > 2 ||
      typeof config.ollamaThink !== 'boolean' || !Number.isInteger(config.ollamaNumCtx) || config.ollamaNumCtx < 1 ||
      (config.geminiThinkingBudget !== null && (!Number.isInteger(config.geminiThinkingBudget) || config.geminiThinkingBudget < -1)))
    throw Error('Invalid evaluation configuration');
  return Object.freeze(config);
}
export const configHash = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
