# Gemini audio and playback

Implemented in the canonical Node/SQLite application. The existing original conversation route, evaluations, and jury exports continue to use the original messages.

## Frontend contract

- `GET /api/ai/status` returns `provider`, `model`, `configured`, `transcription_model`, and `transcription_configured`. Configuration flags describe the environment.
- `GET /api/conversations/:id/transcription` returns `{status, model, messages, error?}`. Status is `missing`, `running`, `done`, or `error`. Only `done` includes messages. Each message retains its original ID, speaker, timestamp, index, and offset.
- `POST /api/conversations/:id/transcription` accepts `{"force":false}`, returns HTTP 202 while the job runs, and returns HTTP 200 for a cached result. Concurrent requests for the same conversation share the running job. Set `force:true` to redo a completed job. Configuration, missing recording, and request errors have explicit HTTP responses.
- `GET /api/audio/:id` streams the stored MP3 with full and single-range responses (200/206/416). Place private MP3s in ignored `data/audio/<conversation-id>.mp3`. Stored URLs may supply MP3s directly or through a Power Automate JSON or HTML wrapper. Downloads are bounded and cached under a separate hashed filename.

Transcription reads `GEMINI_API_KEYS` or `GEMINI_API_KEY` and defaults to `GEMINI_TRANSCRIBE_MODEL=gemini-3.1-flash-lite`. The SQLite result key covers conversation ID, source URL, audio SHA-256, original message SHA-256, model, and prompt version. System and masked rows retain their original text. The model is instructed to respect masks across rows, and the validator masks newly introduced phone-like identifiers and emails in calls with source masks. This check has limited coverage of free-text personal details such as names.

## Evaluation source

`POST /api/evaluate` accepts `transcript_source: "original" | "gemini"` alongside the existing conversation IDs and checklist version. Omit it for original text. A Gemini request uses the latest valid completed alignment for each selected voice call at submission time. If any selected voice call is missing a valid alignment, the entire request returns HTTP 409 with `{error}` before creating a job or any evaluation rows. Chats use original text even in a mixed Gemini batch. Success returns HTTP 202 with `{job_id}` and uses the existing job polling endpoint.

New evaluation responses expose `transcript_source`, `transcription_model` (null for original), and `transcript_hash` (SHA-256 of the ordered input messages). Legacy evaluations may omit these fields and use original text. Evaluation history remains accessible by ID. Gemini job items persist the accepted text snapshot so restarts evaluate the same text. The criterion cache distinguishes Gemini hashes while keeping original cache keys compatible. Jury evidence continues to resolve against original message positions.

## Alignment and limits

Audio is sent as inline MPEG with ID, speaker and timing metadata. Unmasked source
wording is omitted to prevent copying the old transcript. System and masked lines
are supplied as protected text. The response schema requires an object entry for
each message ID; responses are checked for complete and unique IDs, nonempty text
and masked identifiers. More than 80 original messages use sequential chunks of
50 IDs with the complete recording. The final merged alignment is validated again.
This preserves structural positions; semantic timing and speaker alignment still
require listening and human review.

Daily quota errors are detected from Gemini QuotaFailure details and stop retries.
The transcription error includes an approximate wait from RetryInfo when provided.
Keys belonging to one project can share its quota. No model is silently substituted.

## Verification

See [TEAMMATE_MERGE.md](TEAMMATE_MERGE.md) for current integration verification.
External services are stubbed in automated tests; live checks separately use the
five local private MP3s and Gemini API. Recordings and model outputs remain ignored.

References: [Gemini audio guide](https://ai.google.dev/gemini-api/docs/audio),
[GenerateContent API](https://ai.google.dev/api/generate-content),
[Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite).
