// Temporary API backed by shared/mocks so the UI can be built before the real server is ready.
// Real routes must keep the same shapes (see shared/schemas.md).
import { Router } from 'express';
import { readFileSync } from 'node:fs';

const load = (rel) => JSON.parse(readFileSync(new URL(`../../shared/${rel}`, import.meta.url), 'utf8'));
const conversation = load('mocks/conversation.json');
const evaluation = load('mocks/evaluation.json');
const appeal = load('mocks/appeal.json');
const checklist = { id: 1, created_at: '2026-11-08T09:00:00Z', ...load('checklist.default.json') };

export const mockRouter = Router();

mockRouter.get('/conversations', (_req, res) => res.json([{
  conversation_id: conversation.conversation_id,
  channel: conversation.channel,
  language: conversation.language,
  message_count: conversation.messages.length,
  total: evaluation.total,
  gross_error: evaluation.gross_error,
  status: evaluation.status,
}]));
mockRouter.get('/conversations/:id', (_req, res) => res.json(conversation));
mockRouter.get('/checklists', (_req, res) => res.json([{ id: checklist.id, name: checklist.name, created_at: checklist.created_at }]));
mockRouter.get('/checklists/:id', (_req, res) => res.json(checklist));
mockRouter.get('/evaluations', (_req, res) => res.json(evaluation));
mockRouter.get('/appeals', (_req, res) => res.json([{ ...appeal, messages: conversation.messages.slice(6, 9) }]));
