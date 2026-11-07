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
- `timestamp` — исходная метка без изменений: `MM:SS` или `HH:MM:SS` у чатов, ISO 8601 с `Z`, `+05:00` или `+0500` у звонков.
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
  "hash": "sha1(JSON.stringify([title,type,description,na_condition ?? null,scale ?? null]))"
}
```

`hash` считает сервер; ИИ использует ту же формулу. Вес, `na_allowed` и `gross_error` не входят в хеш.
Кешированный ответ проверяется по текущим правилам: невалидный (например, N/A после запрета)
переоценивается моделью, остальные критерии переиспользуются. `na_allowed:true` требует непустой
`na_condition` при сохранении новой версии. После смены формулы старые кеши становятся промахами.

Ключ серверного кеша: `(conversation_id, hash, prompt_version, model)`.
`prompt_version` = `${PROMPT_VERSION}|frt=${threshold}` для c06;
для остальных — `${PROMPT_VERSION}|frt=independent`, поэтому смена порога переоценивает только c06.
Порог по умолчанию 180 с. Модель и версия экспортируются из `ai/evaluate.js`,
переменная окружения `PROMPT_VERSION` не используется. Сервер передаёт `{noCache:true}` в ИИ;
его собственный mem/disk-кеш используется только самостоятельными вызовами/eval.

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
- `explanation` — строка; `evidence_ids` — массив строк ID существующих сообщений.
- `checked_range` обязателен при `no`, кроме критериев с `gross_error:true`: отсутствие нарушения не является пропущенным действием. Концы диапазона должны существовать и идти в порядке from ≤ to.
- Нормализация wire-ответа допускает строковый evidence_ids как массив из одной строки; другие не-массивы становятся []. Обе части валидируют нормализованный CriterionResult одинаково.
- `na` допускается только при `na_allowed`, иначе сервер отклоняет ответ.

Для каждого вызова модели пишется лог (таблица `llm_calls`):

```json
{ "model": "gemini-2.5-flash", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "latency_ms": 0, "prompt": "...", "raw_response": "..." }
```

## Интерфейс модуля ИИ (`ai/evaluate.js`)

```js
// conversation: Conversation; criteria: Criterion[] (все или только изменённые)
// returns { results: CriterionResult[], calls: LlmCall[] }
export async function evaluateConversation(conversation, criteria, checklistMeta, options = {}) {}
```

ИИ делает один повтор невалидных критериев с `<fix_previous_errors>`. Если он не помог,
бросается Error с `{invalidResult:true, criteria:[ids], details:[ошибки], calls:[все вызовы], partial:[валидные ответы]}`.
Сервер журналирует calls, не повторяет такую ошибку и не сохраняет partial/невалидные ответы.
Подстановка answer/scale_value и поле needs_review запрещены.
Временные ошибки провайдера имеют `{status, retryable:true, provider, calls}`;
фатальные 4xx (кроме 429) — `{status, fatal:true, provider, calls}`.
Каждая HTTP-попытка, включая неудачную, имеет LlmCall; без usage токены и стоимость — 0.
После успешного HTTP исключения не теряют calls. Модельные не-JSON/пустые результаты
проходят тот же один повтор валидации. Успешный ответ дополнительно может содержать
`cached_count` (число критериев из ИИ-кеша) и `evaluated_criteria` (IDs запрошенных критериев).

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

В `jobs.data.items[]` сохраняются `{conversation_id,evaluation_id,status,model,prompt_key}`.
`evaluations.data` сохраняет `prompt_key`, `evaluated_criteria`, `full_eval` и при ошибке `error`;
`model` хранится в отдельной колонке. Изменение модели/версии при восстановлении незавершённой
задачи даёт error с просьбой поставить её заново. Уже done Evaluation не перезаписывается,
даже если item остался running после сбоя.

`total` считается по `final`, `original_total` — по `original`. Если применимых критериев с весом нет, `total` равен `null`.

## Appeal и ReviewDecision

```json
{ "id": 1, "evaluation_id": 12, "criterion_id": "c04", "comment": "...", "status": "open | decided", "created_at": "..." }
{ "appeal_id": 1, "action": "confirm | change", "new_answer": "yes", "new_scale_value": null, "new_evidence_ids": ["m004"], "new_checked_range": {"from":"m004","to":"m004"}, "reason": "...", "decided_at": "..." }
```

При action=change `new_evidence_ids` и `new_checked_range` необязательны; диапазон допускает null.
Если поле не передано, сохраняется прежнее. Для no без явно переданного диапазона сервер может
вывести его из evidence. Итоговый CriterionResult валидируется общим правилом; ошибка → 400.
`original` не меняется, `final` и решение сохраняются атомарно.

## Импорт API организаторов

Основной формат: `{isSuccess:true,data:{records:[Conversation|RawRecord]}}`.
Также поддерживаются массивы `conversations`, `data.conversations` и `data`.
В RawRecord сообщения берутся из `messages ?? transcript`.
Каналы и роли соответствуют Conversation; неизвестные значения отклоняются явно.
ID присваиваются по порядку, исходный timestamp сохраняется. Нехронологичность
даёт ошибку с conversation_id и ID реплики. Все записи пакета атомарны.
Изменения под существующими ID → 409 `{error,conflict_ids:[все конфликтные ID]}`;
идентичные записи безопасно импортируются повторно.
Неверный/пустой ORG_API_URL → 503; сеть → 502; таймаут → 504;
не-JSON/неверные данные/HTTP-ошибка организаторов → 502; `isSuccess != true` → 502 с body.error.

## Stats

- `calls`: количество HTTP-попыток в llm_calls; `tokens`: input + output, включая thinking.
- `cost_usd`: сумма расчётной стоимости всех попыток; `avg_latency_ms`: среднее время попытки.
- `avg_cost_per_eval`: совместимость — вся стоимость / число уникальных evaluation_id с вызовами (ошибки и частичные включены, кеш исключён).
- `evaluations_done`: число оценок done, включая полностью кешированные.
- `evaluations_with_calls`: число оценок хотя бы с одним вызовом, включая error и частичные.
- `avg_cost_per_full_eval`: сумма стоимости всех вызовов полных оценок (включая неудачные попытки) / их количество. Полная: модель получила все критерии версии, есть хотя бы один вызов; partial/cache исключены. При пустом знаменателе 0. Исторические оценки без full_eval не входят.

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
| GET | `/api/stats` | `{calls, tokens, cost_usd, avg_cost_per_eval, avg_latency_ms, evaluations_done, evaluations_with_calls, avg_cost_per_full_eval}` |
