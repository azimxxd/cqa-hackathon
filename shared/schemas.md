# Контракты данных и API

Этим файлом владеет Азамат. Хотите что-то поменять — делайте PR и пишите в общий чат: от этого формата зависят все три части.

## Conversation

Приходит из API организаторов. ID реплик присваиваются при импорте по порядку и больше не меняются.

```json
{
  "conversation_id": "p1-ru-001",
  "channel": "agent chat",
  "language": "RU",
  "audio_url": null,
  "messages": [
    { "id": "m001", "idx": 0, "timestamp": "00:02", "offset_sec": 0, "speaker": "client", "text": "..." }
  ]
}
```

- `channel` — `agent chat` или `voice call`.
- `speaker` — `client`, `operator`, `bot` или `system`.
- `timestamp` — исходная метка без изменений: `MM:SS` у чатов, ISO 8601 с часовым поясом у звонков.
- `offset_sec` — секунды от первой реплики. Нужен для перемотки плеера и подсчёта пауз.

## ChecklistVersion

Версия неизменяема: при каждом сохранении создаётся новая.

```json
{
  "id": 3,
  "name": "...",
  "created_at": "2026-11-08T10:00:00Z",
  "rounding": 2,
  "first_reaction_threshold_sec": 180,
  "sections": [{ "id": "s1", "title": "..." }],
  "criteria": [Criterion]
}
```

## Criterion

```json
{
  "id": "c04",
  "section": "s2",
  "title": "Корректная и полная консультация",
  "type": "binary | scale",
  "weight": 20,
  "na_allowed": true,
  "scores_points": true,
  "gross_error": false,
  "description": "текст критерия",
  "na_condition": "когда ставить N/A",
  "scale": [{ "value": 20, "label": "..." }],
  "hash": "sha1(title+type+description+na_condition+scale)"
}
```

`hash` считает сервер. По нему работает кеш: если хеш не изменился, модель повторно не вызывается.

## CriterionResult (ответ ИИ, Алдияр → сервер)

```json
{
  "criterion_id": "c07",
  "answer": "yes | no | na",
  "scale_value": null,
  "explanation": "Завершение — Нет. После ответа оператор закрыл чат без прощания.",
  "evidence_ids": ["m014", "m015"],
  "checked_range": { "from": "m012", "to": "m015" }
}
```

- `binary`: `answer` равен `yes`, `no` или `na`, а `scale_value` равен `null`.
- `scale`: `answer` равен `null` или `na`, а `scale_value` берётся только из значений `scale`.
- `checked_range` обязателен, если действие пропущено (`no`). Указывает место, где действие ожидалось.
- `na` допускается только при `na_allowed`, иначе сервер отклоняет ответ.

Для каждого вызова модели пишется лог (таблица `llm_calls`):

```json
{ "model": "gemini-2.5-flash", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "latency_ms": 0, "prompt": "...", "raw_response": "..." }
```

## Интерфейс модуля ИИ (`ai/evaluate.js`)

```js
// conversation: Conversation; criteria: Criterion[] (все или только изменённые)
// returns { results: CriterionResult[], calls: LlmCall[] }
export async function evaluateConversation(conversation, criteria, checklistMeta) {}
```

## Evaluation (сервер → UI)

```json
{
  "id": 12,
  "conversation_id": "p1-ru-001",
  "checklist_version_id": 3,
  "status": "queued | running | done | error",
  "criteria": [
    {
      "criterion_id": "c04",
      "original": CriterionResult,
      "final": CriterionResult,
      "appealed": false,
      "weight": 20,
      "effective_weight": 25.0,
      "points": 18.75
    }
  ],
  "sections": { "s1": { "points": 0, "max": 0 } },
  "total": 87.5,
  "gross_error": false,
  "original_total": 87.5,
  "cost_usd": 0.0004,
  "model": "gemini-2.5-flash",
  "created_at": "..."
}
```

`total` считается по `final`, `original_total` — по `original`. Если применимых критериев с весом нет, `total` равен `null`.

## Appeal и ReviewDecision

```json
{ "id": 1, "evaluation_id": 12, "criterion_id": "c04", "comment": "...", "status": "open | decided", "created_at": "..." }
{ "appeal_id": 1, "action": "confirm | change", "new_answer": "yes", "new_scale_value": null, "reason": "...", "decided_at": "..." }
```

## REST API

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/api/import` | `{group_id}` → `{imported}` |
| GET | `/api/conversations` | список с последним итогом |
| GET | `/api/conversations/:id` | Conversation |
| GET | `/api/checklists` | список версий |
| GET | `/api/checklists/:id` | ChecklistVersion (`latest` разрешено) |
| POST | `/api/checklists` | ChecklistVersion без id → новая версия |
| POST | `/api/evaluate` | `{conversation_ids: [...] \| "all", checklist_version_id}` → `{job_id}` |
| GET | `/api/jobs/:id` | `{status, done, total, errors}` |
| GET | `/api/evaluations?conversation_id=&checklist_version_id=` | Evaluation (последняя) |
| POST | `/api/appeals` | `{evaluation_id, criterion_id, comment}` |
| GET | `/api/appeals?status=open` | Appeal + фрагмент диалога |
| POST | `/api/appeals/:id/decision` | ReviewDecision → обновлённая Evaluation |
| GET | `/api/stats` | `{calls, tokens, cost_usd, avg_cost_per_eval, avg_latency_ms}` |
