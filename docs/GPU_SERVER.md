# Локальный GPU-контур (NVIDIA Brev)

Инстанс `loxlka-d05391`: AWS g6e.4xlarge, 1× NVIDIA L40S (46 ГБ VRAM), 16 vCPU,
124 ГиБ RAM, Ubuntu 22.04, драйвер 595.112.07 / CUDA 13.2. Тариф $3.65/час —
останавливайте инстанс, когда он не нужен (`brev stop loxlka-d05391`).

## Доступ

```sh
brev login && brev refresh            # ключи и ssh-конфиг кладёт сам Brev
ssh -N -L 11434:127.0.0.1:11434 loxlka-d05391   # туннель к Ollama
```

Ollama слушает только `127.0.0.1` на сервере: наружу порт не открыт, данные
идут через SSH-туннель.

## Текст: Ollama + Qwen3.6-35B-A3B (Q4_K_M, ~23 ГБ)

```sh
curl -fsSL https://ollama.com/install.sh | sh
# /etc/systemd/system/ollama.service.d/cqa.conf
#   OLLAMA_HOST=127.0.0.1:11434  OLLAMA_NUM_PARALLEL=4  OLLAMA_KEEP_ALIVE=-1
#   OLLAMA_FLASH_ATTENTION=1     OLLAMA_KV_CACHE_TYPE=q8_0  OLLAMA_CONTEXT_LENGTH=16384
ollama pull qwen3.6:35b-a3b
```

`.env` приложения:

```sh
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.6:35b-a3b
LLM_CONCURRENCY=4        # = OLLAMA_NUM_PARALLEL
# OLLAMA_THINK=1         # точнее, но ~5× медленнее
```

## Аудио: faster-whisper large-v3 (float16, ~4–5 ГБ)

```sh
python3 -m venv ~/asr
~/asr/bin/pip install faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
~/asr/bin/python scripts/gpu/asr_benchmark.py call1.mp3 call2.mp3
```

Скрипт сам добавляет pip-библиотеки CUDA 12 в `LD_LIBRARY_PATH` (CTranslate2 собран под CUDA 12).
Веса — `~/models/whisper` (корневой диск; `/opt/dlami/nvme` эфемерный).

## Замеры (7 ноября 2026, 65 размеченных DEV-диалогов, промпт v15)

| Конфигурация | Точность по критериям | MAE итога | Ошибок | Задержка на диалог |
|---|---|---|---|---|
| Qwen3.6-35B-A3B, thinking выкл | 0.921 | 3.16 | 0/65 | ~23 с (4 параллельно), 65 диалогов ≈ 6 мин |
| Qwen3.6-35B-A3B, thinking вкл (`OLLAMA_THINK=1`) | 0.940 | 3.12 | 1/65 | ~85 с (4 параллельно), 65 диалогов ≈ 24 мин |
| **Промпт v16**, thinking выкл | **0.960** | 2.61 | 0/65 | 65 диалогов ≈ 6.7 мин |

v16 (по разбору промахов v15): c02 — «нет уточняющего вопроса оператора → yes запрещён»
(0.662 → 0.892); c07 — обрыв по вине клиента/системы сразу после его реплики → N/A
(0.923 → 0.985); c03 — N/A, только если клиент сам отложил проверку (0.969 → 0.985);
правило «сначала переведи KZ/EN-реплики на русский» (c05 0.938 → 0.969, починило
p1-kz-015). Остаток c02 — 4 звонка/чата с «yes», где модель ставит N/A, и 3 «no» → N/A.
Все правила подобраны на тех же 65 DEV-диалогах: на контрольном наборе ждите цифру ниже.

**Прогрев после `brev start`:** EBS-диск восстанавливается из снапшота лениво (~5 МБ/с),
первая загрузка 22 ГБ модели идёт 20–30 мин; `OLLAMA_LOAD_TIMEOUT=30m` в `cqa.conf`
не даёт Ollama оборвать её. Поднимайте сервер заранее до контрольного прогона.

Без thinking слабое место — c02 (0.662): модель ставит «yes» там, где разметка «N/A»;
thinking поднимает c02 до 0.862. Единственная ошибка с thinking (p1-kz-005) — невалидный
ответ после ретрая; она же даёт промахи c01/c08 в отчёте. Ориентир облака: Gemini
3.5 Flash-Lite на промпте v7 — 0.992 (промпт с тех пор менялся, сравнение не прямое).

Whisper large-v3 на 5 DEV-звонках (RU, 5–10 мин): 12–26 с на звонок в одиночку,
21–46 с при одновременной работе Qwen; язык определён с p ≥ 0.99. Qwen с кэшем на
4 потока занимает ~24.6 ГБ VRAM из 46; whisper добавляет ещё ~4–5 ГБ — параллельная
работа помещается с запасом.

## Хостинг приложения на том же сервере

Приложение и публичный адрес работают прямо на Brev рядом с Qwen — без Mac и SSH-туннеля.
Файлы: [deploy/brev/](../deploy/brev/) — `cqa.service` (Node, `~/cqa-hackathon`, `.env`),
`cqa-tunnel.service` (Cloudflare quick tunnel на `localhost:3000`), `install.sh`.

`.env` сервера — как локальный, но с `LLM_PROVIDER=ollama`,
`OLLAMA_URL=http://127.0.0.1:11434`, `OLLAMA_MODEL=qwen3.6:35b-a3b`, `LLM_CONCURRENCY=4`.
`.env`, `data/cqa.db`, `data/dev.json` и `data/audio/` копируются `scp`, в git их нет.

Обновить код: `ssh loxlka-d05391 'cd ~/cqa-hackathon && git pull --ff-only && sudo systemctl restart cqa'`.

После `brev start` оба сервиса поднимаются сами, но **адрес quick tunnel меняется**. Новый:

```sh
ssh loxlka-d05391 'journalctl -u cqa-tunnel --no-pager | grep -o "https://[a-z0-9-]*\.trycloudflare\.com" | tail -1'
```

Первая оценка после старта ждёт загрузки Qwen с диска (до 20–30 мин, см. «Прогрев»).
Прогреть заранее: `ssh loxlka-d05391 'curl -s localhost:11434/api/generate -d "{\"model\":\"qwen3.6:35b-a3b\",\"keep_alive\":-1}"'`.
