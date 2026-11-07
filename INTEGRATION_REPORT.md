# Отчёт интеграции CQA

Дата: 7 ноября 2026. Ветка: `azamat/integration-fixes`.

## Исходное состояние

- Серверная ветка: `azamat/server-core`, HEAD `2def97a`; база `b36ee6a`.
- Проверены побайтно все 68 неотслеживаемых файлов: 2 в ai/, eval/score.js и 65 labels. Все совпали с `origin/aldiyar/ai-v1` (`d3213e4`); только после проверки они удалены перед merge.
- Создана новая ветка и выполнен merge `--no-ff`: `8cb0119`. Конфликтов не было.
- После merge: **21 тест, 21 pass, 0 fail**.
- Первым добавлен `server/integration.test.js`, коммит `f668add`. Исходный прогон: **2 pass / 5 fail**. Воспроизведены подстановка невалидных ответов, c08 без диапазона, обратный диапазон, строковый evidence и 12 HTTP-попыток при 429.

## Исправления и доказательства

Строки относятся к финальному состоянию файлов. Форматирование вынесено в отдельные коммиты; в таблице указаны содержательные коммиты.

| Проблема | Что сделано | Файл:строка | Тест, который ловит ошибку | Коммит |
|---|---|---|---|---|
| Нет теста настоящего пути jobs → AI → Gemini | Харнес с настоящим evaluateConversation, подменённым fetch, usage и восстановлением окружения | `server/integration.test.js:25` | 8 integration-тестов, включая исходные 7 сценариев | `f668add`, `5913939` |
| Разные правила валидаторов | c08 no без диапазона разрешён; from ≤ to; explanation/evidence и тип диапазона проверяются в обеих частях | `server/scoring.js:34`, `ai/validate.js:41` | `server/validation.test.js:11`, integration gross/range | `314b3ae`, `adfbadc`, `0ac3467`, `f658710` |
| sanitize выдумывал no и ближайший балл | Ответы не меняются; после одного feedback-повтора Error с criteria/details/partial/calls; needs_review удалён | `ai/evaluate.js:198`, `ai/validate.js:88`, `server/jobs.js:201` | integration persistent invalid; `ai/providers/providers.test.js:68` | `314b3ae`, `adfbadc` |
| Сервер обходил собственный кеш через AI memCache; разные модель/версия | Экспорты AI — источник модели/версии, env PROMPT_VERSION игнорируется; noCache:true; AI-кеш при серверных вызовах не читается и не заполняется | `server/jobs.js:44`, `server/jobs.js:175`, `ai/evaluate.js:130` | `server/integration.test.js:216`; jobs model/version cache boundaries | `314b3ae`, `5913939` |
| Порог не входил в кеш | Составной prompt_version; изменение threshold переоценивает только c06 | `server/jobs.js:49`, `ai/evaluate.js:59` | `server/jobs.test.js:219`, integration cache, E2E | `314b3ae`, `5913939` |
| 12 запросов при 429, потеря ошибок/стоимости | Ограниченные ретраи провайдера, статусы и retryable/fatal; сервер повторяет только retryable; журнал каждой HTTP-попытки; malformed HTTP 200 сохраняет логи | `ai/providers/request.js:3`, `ai/providers/gemini.js:7`, `ai/providers/ollama.js:21`, `server/jobs.js:201` | provider network/503/400/JSON tests; integration 429: 4 HTTP при A=2, R=1 | `314b3ae`, `adfbadc`, `a3334e4` |
| evidence_ids строкой вызывал TypeError | Строка → массив из одной строки, остальные не-массивы → [] | `ai/validate.js:2` | integration string evidence; provider evidence normalization | `314b3ae` |
| Запрет N/A ломал кеш вместо переоценки | Каждый кешированный ответ валидируется; невалидный критерий уходит модели, остальные используются повторно. Это действует и в standalone AI | `server/jobs.js:146`, `ai/evaluate.js:133` | `server/jobs.test.js:134`, standalone N/A cache test | `5913939`, `0a7ab53` |
| После рестарта смешивались m1 и m2/v9 | model и prompt_key фиксируются в item и Evaluation; при смене настроек незавершённый item получает error | `server/jobs.js:113`, `server/jobs.js:320`, `server/evaluations.js:63` | `server/jobs.test.js:269`, существующий persistence test | `5913939` |
| Повтор после COMMIT затирал решения проверяющего | done Evaluation проверяется до обработки; INSERT OR REPLACE убран | `server/jobs.js:118`, `server/jobs.js:215` | `server/jobs.test.js:306` | `5913939` |
| Импорт не понимал реальную оболочку и timestamps | data.records + transcript, явные карты ролей/каналов, HH:MM:SS, +0500, ошибки с ID; статусы 502/503/504; полный список конфликтов 409; атомарность | `server/import.js:11`, `server/import.js:89`, `server/import.js:139` | `server/import.test.js:78`, `:136`, `:206`; import-http records | `134fdb1` |
| Проверяющий не мог задать evidence/range | change принимает новые evidence/range, валидирует итоговый CriterionResult, сохраняет original | `server/routes/appeals.js:111` | `server/appeals.test.js:111`, E2E change | `cd8798b` |
| Неясная стоимость оценки | Старое поле оставлено; добавлены done, with_calls и средняя стоимость полных оценок с неудачными попытками | `server/routes/stats.js:2`, `server/jobs.js:156` | `server/stats.test.js:33`: ручной расчёт 1.9 total, full average 0.5 | `cd8798b`, `5913939` |
| N/A в промпте противоречил схеме; возможна разметка из диалога | Явный текст для пустого условия; сервер требует условие; все < > реплик заменены на ‹ ›; версия промпта v2 | `ai/prompt.js:5`, `:28`, `:46`, `server/routes/checklists.js:4` | `ai/ai.test.js:135`, `server/routes.test.js:33` | `f1ab6f3`, `b9ebbb2` |
| Теги сокращали первую реакцию; «проверьте раздел» считалось ожиданием | Только системные переводы/эскалации становятся началом отсчёта; теги/вложения пропускаются; узкий WAIT_RE, константа 60 с | `ai/timing.js:6`, `:8`, `:10`, `:75` | `ai/ai.test.js:156`, `:193`, `:229` | `f1ab6f3`, `0a7ab53` |
| Eval расходился с UI и исключал ошибки из accuracy | Импорт server/scoring; каждый ошибочный диалог — промах по всем размеченным критериям; ошибки/кеш видны отдельно; стоимость по тому же определению полных оценок | `eval/score.js:3`, `eval/metrics.js:2`, `eval/run.js:88` | `eval/metrics.test.js:9`, AI gross-error score test | `aaeac37`, `f1ab6f3` |
| Коллизия хеша AB+C и A+BC | sha1(JSON.stringify([...])) в обеих частях; производный hash старых ChecklistVersion обновляется при чтении | `server/db.js:8`, `:45`, `ai/evaluate.js:32` | `server/db.test.js:30`, `:51` | `0e2f06f`, `314b3ae` |
| Данные/кеши могли попасть в git, документация устарела | ignore всех заданных путей; README, серверная документация и общий контракт обновлены | `.gitignore:6`, `README.md:1`, `server/README.md:1`, `shared/schemas.md:1` | git check-ignore по всем пяти путям, status --ignored, diff --check | `cfd23c0`, `fa91bb7`, `a7b05d6` |
| Не было полного воспроизводимого сценария | Изолированный API E2E с двумя диалогами, Gemini/API-стабами и рестартом SQLite | `scripts/e2e-stub.js:1` | `node scripts/e2e-stub.js` — OK, 6 вызовов заглушки Gemini | `0f6593d`, `84fe112` |

Каждый содержательный блок проверялся npm test. Для исправлений воспроизводящие тесты запускались до правки; первоначальные падения сохранены в рабочих логах `/tmp/cqa-*-before.log` и `/tmp/cqa-harness-baseline.log`. Эти временные логи не входят в репозиторий.

## Принятые решения и уточнения контракта

1. В задании одновременно указаны ключ `${PROMPT_VERSION}|frt=${threshold}` и требование при смене порога переоценивать только c06. Поэтому порог включён в ключ c06; остальные используют `frt=independent`. Весь item фиксирует полный prompt_key для восстановления. Это описано в shared/schemas.md и server/README.md.
2. Для единого хеша выбрана явно заданная формула шага 10: title/type/description/na_condition/scale. na_allowed и gross_error не входят в хеш; повторная валидация кеша предотвращает незаконное переиспользование. Старые хеши ChecklistVersion пересчитываются при чтении, без изменения текста версии.
3. Полная оценка для стоимости — модель получила все критерии версии и есть хотя бы одна HTTP-попытка; учитываются и итоговые ошибки. Исторические оценки без full_eval не угадываются и исключены из нового среднего. Старое avg_cost_per_eval сохранено.
4. llm_calls теперь содержит каждую HTTP-попытку. Если провайдер не вернул usage, токены и расчётная стоимость равны 0. Финансовая стоимость неизвестных попыток не выдумывается. При постоянном 429 максимум по умолчанию 8 HTTP для Gemini; общий потолок с feedback-повторами и временными сбоями — 16. Подробная формула есть в server/README.md.
5. Старые незавершённые jobs без зафиксированных настроек получают ту же ошибку, что и jobs со сменившимися настройками. Готовые Evaluation всегда сохраняются.
6. Для MAE ошибки не имеют выдуманного числового прогноза: они учитываются как промахи в accuracy и в errors; total_mae_evaluations показывает количество числовых пар для MAE.

Все изменения форматов и поведения отражены в `shared/schemas.md` отдельным коммитом `a7b05d6`. PLAN.md не изменялся.

## Что не делалось и почему

- Не вызывались реальные Gemini/Ollama и API организаторов: это запрещено заданием. Реальная точность, стоимость на DEV и соответствие неизвестных ролей/каналов реальному набору не измерены.
- Локального `data/dev.json` нет. Для records/transcript созданы синтетические примеры той же формы; неизвестные значения ролей/каналов отклоняются, соответствия не выдумываются.
- `npm run eval` на настоящих DEV-данных не запускался. Логика метрик проверена отдельными тестами, и все 65 существующих labels успешно проходят общий расчёт score.
- web/, .env и локальная data/cqa.db не редактировались; все проверки используют in-memory или временную БД. Push/PR не выполнялись.

## Коммиты для владельца ИИ

Исходный `d3213e4` уже принадлежит ИИ-ветке; повторно передавать его не требуется.
Новые коммиты для отдельного PR, в порядке применения:

| Коммит | Содержание | Зависимости |
|---|---|---|
| `314b3ae` | Честная ошибка вместо sanitize, нормализация/валидация, кеш/noCache, ограниченные ретраи и журнал | База d3213e4. Прямых импортов server/shared нет; интеграционное поведение требует adfbadc и 5913939 |
| `f1ab6f3` | Промпт v2, экранирование, timing, тест gross-error score | Для нового score-теста нужен aaeac37; runtime AI независим от server |
| `aaeac37` | Общий scoring, ошибки accuracy, стоимость/кеш в metrics | Импортирует server/scoring.js: нужен реализованный серверный scoring из server-core (33f6dad и текущая версия); совместимый shared-контракт a7b05d6 |
| `0a7ab53` | Перепроверка standalone кеша после запрета N/A, короткое «Минуту» | 314b3ae + f1ab6f3 |
| `3805bc4` | Форматирование ai/ | Все предыдущие изменения ai/ |
| `73f1146` | Форматирование eval/ | aaeac37 |
| `a3334e4` | Повреждённый успешный ответ провайдера не теряет calls | 314b3ae + форматирование 3805bc4 |
| `0ac3467` | Тип checked_range проверяется строго | Регрессионный общий тест находится в серверном f658710; runtime независим |

Патчи ai:/eval: проверены: каждый изменяет только свою папку, смешивания с server/ нет. Для полностью зелёного набора на стороне ИИ передавайте AI и eval коммиты вместе с доступным server/scoring.js.

## Финальная проверка

Основной runtime: Node v24.19.0.

Последние строки `npm test`:

```text
ℹ tests 55
ℹ suites 0
ℹ pass 55
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 326.607042
```

Node 22.13.0 (`npx -y node@22.13.0 --test`):

```text
1..55
# tests 55
# suites 0
# pass 55
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 263.591834
```

`node server/verify-start.js`:

```text
npm start: health OK
```

`node scripts/e2e-stub.js`:

```text
E2E stub OK: records import → evaluate → appeal/change → weights/cache → c04 only → c06 only → restart; 6 stub Gemini calls, no external requests.
```

E2E подтвердил: original_total 77.69 → final total 85.38 после review; смена только веса без новых вызовов; смена текста только c04; смена порога только c06; оценки, решения, jobs, статистика и импорт переживают повторное открытие SQLite.

`git check-ignore -v` подтвердил все пять путей: data/*.json, data/ai-cache/, eval/reports/, eval/.cache/, eval/data/.
`git diff --check` — без замечаний. `git status --short` перед коммитом этого отчёта — пусто.
`git status --ignored` показывает только существующие data/cqa.db*, node_modules/. Данные и ключи не добавлялись.

## История b36ee6a..HEAD

Ниже история до коммита самого отчёта. Все сообщения имеют согласованные префиксы.

```text
f658710 server: verify checked range types in both validators
0ac3467 ai: reject non-object checked ranges
a3334e4 ai: preserve logs for malformed successful provider responses
cfd23c0 repo: document setup and ignore organizer data caches and reports
fa91bb7 server: document queue retry cache import and review behavior
a7b05d6 shared: document validation cache import review and statistics contracts
84fe112 repo: format isolated end-to-end scenario
696fb9e server: format integration fixes for review
73f1146 eval: format scoring and metric reports for review
3805bc4 ai: format integration fixes for review
0f6593d repo: exercise full API workflow with isolated database and network stubs
0a7ab53 ai: revalidate cached answers after N/A policy changes
0e2f06f server: hash structured criterion fields and invalidate legacy cache keys
b9ebbb2 server: require a condition when enabling N/A in checklists
aaeac37 eval: share server scoring and count failed evaluations in accuracy and cost
f1ab6f3 ai: escape transcript markup and correct timing facts in prompt v2
cd8798b server: accept review evidence and report full evaluation costs
134fdb1 server: import organizer records atomically with precise HTTP errors
5913939 server: pin queue settings and use one validated criterion cache
adfbadc server: align result validation and retry only explicit transient errors
314b3ae ai: reject invalid results and bound provider retries with complete call logs
f668add server: reproduce real AI integration failures with stubbed Gemini
8cb0119 repo: integrate AI v1 with server core
d3213e4 ai: evaluation pipeline, timing/validation, eval harness and 65 DEV labels
2def97a server: verify HTTP import restart recovery and cache boundaries
11c6c4f server: format server modules for review
6dab85e server: aggregate LLM usage and costs from persisted call logs
29ebec5 server: add appeals evidence windows and atomic review decisions
ea75d4c server: persist evaluation jobs with bounded retries and criterion cache
4fb958c server: replace mock router with persisted conversation checklist and evaluation routes
33f6dad server: score original and final results with normalized section totals
bef4f94 server: import organizer conversations atomically with stable messages
287d717 server: initialize SQLite schema and default checklist
```

## Дополнительная проверка после интеграции

По запросу продолжить работу найдены и исправлены ещё три проблемы. Разделы выше
сохраняют снимок первой интеграции (`c9f5907`); актуальный результат — **61/61** тест.

| Проблема | Исправление | Файл:строка | Регрессионный тест | Коммит |
|---|---|---|---|---|
| Обрезанный JSON дискового кеша ломал standalone AI/eval | Повреждённый кеш становится промахом; файлы заменяются через уникальный временный файл и rename, временный файл убирается | `ai/evaluate.js:81`, `:98` | `ai/cache.test.js`: испорченный файл → новый ответ → повторный запуск читает восстановленный кеш без HTTP | `d576daf` |
| Нечитаемый JSON original в серверном кеше ломал весь job | Разбор JSON включён в проверку кеша; модели отправляется только повреждённый критерий | `server/jobs.js:148` | jobs test «malformed cached JSON…»: переоценивается только c01, итог 77.69, следующий запуск без нового вызова | `e77c8d4` |
| Нулевая/нечисловая параллельность могла дать отчёт без обработки диалогов; неверный limit не проверялся | Положительные безопасные целые числа проверяются до загрузки DEV; CLI перекрывает env | `eval/run.js:35`, `:42`, `:46` | `eval/run.test.js`: CLI/env, 0, отрицательные/дробные/нечисловые/слишком большие/пустые значения; любой fetch в дочернем процессе запрещён | `da16915` |

Все регрессионные тесты сначала воспроизвели ошибки. API/ключи/интерфейс/рабочая БД
не затронуты. Изменений внешнего контракта нет; обновлены README и server/README.

Дополнительно передать владельцу ИИ коммиты `d576daf` (ai:) и `da16915` (eval:).
Они не зависят от нового серверного коммита; используют предыдущие изменения ai/eval
и существующий server/scoring.js. Зоны файлов в коммитах не смешиваются.

Последние проверки:

```text
ℹ tests 61
ℹ suites 0
ℹ pass 61
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 557.4805
```

Node 22.13.0:

```text
1..61
# tests 61
# suites 0
# pass 61
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 748.260875
```

`node scripts/e2e-stub.js` — OK, 6 запросов к заглушке Gemini, внешних запросов нет.
`node server/verify-start.js` — `npm start: health OK`.
`git diff --check` — без замечаний. Все данные кеш-тестов создаются во временных папках.
