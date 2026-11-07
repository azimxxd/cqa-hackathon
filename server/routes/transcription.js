import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import {
  MAX_AUDIO_BYTES, transcribe, transcriptionConfigured, transcriptionModel,
  TRANSCRIPTION_PROMPT_VERSION,
} from "../../ai/transcription.js";
import { getKeys } from "../../ai/providers/gemini.js";
import { modelName } from "../../ai/evaluate.js";
import { byteRange, createAudioStore, hash } from "../audio.js";
import { asyncRoute, fail } from "../http.js";
import { getConversation } from "../import.js";

export function transcriptionRoutes(db, options = {}) {
  const router = Router();
  const audio = createAudioStore(options.audio);
  const running = new Map();
  const get = db.prepare("SELECT status, messages, error FROM transcriptions WHERE cache_key = ?");
  const save = db.prepare(`
    INSERT INTO transcriptions (cache_key, conversation_id, status, messages, error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET status=excluded.status,
      messages=excluded.messages, error=excluded.error
  `);
  const state = (status, model, messages = []) => ({ status, model, messages });

  function voice(req) {
    const conversation = getConversation(db, req.params.id);
    if (!conversation) throw fail(404, "Conversation not found");
    if (conversation.channel !== "voice call") throw fail(404, "Conversation has no voice recording");
    return conversation;
  }

  async function recording(conversation, model, file) {
    const bytes = file ? await readFile(file.path) : null;
    if (bytes && (!bytes.length || bytes.length > MAX_AUDIO_BYTES))
      throw fail(413, "Invalid recording size");
    const key = hash(JSON.stringify([
      conversation.conversation_id, model, TRANSCRIPTION_PROMPT_VERSION,
      hash(JSON.stringify(conversation.messages)),
      bytes ? hash(bytes) : null,
      conversation.audio_url,
    ]));
    return { bytes, key };
  }

  function cached(key, model) {
    const row = get.get(key);
    return row ? {
      ...state(row.status, model, row.messages ? JSON.parse(row.messages) : []),
      ...(row.error ? { error: row.error } : {}),
    } : state("missing", model);
  }

  async function resolveTranscription(conversation) {
    const id = conversation.conversation_id;
    const unavailable = () => fail(409, `Gemini transcription is missing or stale for ${id}`);
    if (running.has(id)) throw unavailable();
    const model = transcriptionModel();
    try {
      const file = await audio.find(conversation);
      if (file) {
        const { key } = await recording(conversation, model, file);
        if (!running.has(id) && model === transcriptionModel()) {
          const result = cached(key, model);
          if (result.status === "done")
            return { model, messages: result.messages };
        }
      }
    } catch {
      // An unreadable recording or corrupt cached record is unavailable.
    }
    throw unavailable();
  }

  router.get("/ai/status", (_req, res) => {
    const ollama = process.env.LLM_PROVIDER?.toLowerCase() === "ollama";
    let configured = ollama;
    if (!ollama) {
      try {
        configured = getKeys().length > 0;
      } catch {
        configured = false;
      }
    }
    res.json({
      provider: ollama ? "ollama" : "gemini",
      model: modelName(),
      configured,
      transcription_model: transcriptionModel(),
      transcription_configured: transcriptionConfigured(),
    });
  });

  router.get("/audio/:id", asyncRoute(async (req, res) => {
    const { path, size } = await audio.load(voice(req));
    const range = req.get("range");
    res.set({ "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
    const bounds = range === undefined ? [0, size - 1] : byteRange(range, size);
    if (!bounds) {
      res.set("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    const [start, end] = bounds;
    if (range !== undefined) {
      res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.set({ "Content-Type": "audio/mpeg", "Content-Length": String(end - start + 1) });
    if (req.method === "HEAD") return res.end();
    await pipeline(createReadStream(path, { start, end }), res).catch((error) => {
      if (!res.destroyed) throw error;
    });
  }));

  router.get("/conversations/:id/transcription", asyncRoute(async (req, res) => {
    const conversation = voice(req);
    const job = running.get(conversation.conversation_id);
    if (job) return res.json(state("running", job.model));
    const model = transcriptionModel();
    const { key } = await recording(conversation, model, await audio.find(conversation));
    res.json(cached(key, model));
  }));

  router.post("/conversations/:id/transcription", asyncRoute(async (req, res) => {
    const conversation = voice(req);
    const id = conversation.conversation_id;
    const force = req.body?.force ?? false;
    if (typeof force !== "boolean") throw fail(400, "force must be a boolean");
    const existing = running.get(id);
    if (existing) return res.status(202).json(state("running", existing.model));
    const model = transcriptionModel();
    const file = await audio.find(conversation);
    const source = await recording(conversation, model, file);
    const active = running.get(id);
    if (active) return res.status(202).json(state("running", active.model));
    const previous = cached(source.key, model);
    if (!force && previous.status === "done") return res.json(previous);
    if (!transcriptionConfigured()) throw fail(503, "Gemini transcription is not configured");
    if (!file && !conversation.audio_url) throw fail(404, "Recording is unavailable");
    if (!conversation.messages.length) throw fail(422, "Original transcript is empty");

    const job = { model };
    running.set(id, job);
    job.task = (async () => {
      let key = source.key;
      try {
        const input = file ? source : await recording(conversation, model, await audio.load(conversation));
        key = input.key;
        if (!force && cached(key, model).status === "done") return;
        const messages = await transcribe({ audio: input.bytes, messages: conversation.messages, model });
        save.run(key, id, "done", JSON.stringify(messages), null);
      } catch (error) {
        save.run(key, id, "error", null, error.message);
      }
    })().catch(() => {
      // Do not leak provider data or reject after the HTTP request has returned.
      console.error("Could not persist transcription status");
    }).finally(() => running.delete(id));
    res.status(202).json(state("running", model));
  }));

  return { router, resolveTranscription, close: () => Promise.all([...running.values()].map((job) => job.task)) };
}
