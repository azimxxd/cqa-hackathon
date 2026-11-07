import { now, transaction } from "./db.js";
import { fail } from "./http.js";
const CHANNELS = new Map([
  ["agent chat", "agent chat"],
  ["voice call", "voice call"],
]);
const SPEAKERS = new Map(
  ["client", "operator", "bot", "system"].map((value) => [value, value]),
);

export function timestampSeconds(timestamp, channel) {
  if (typeof timestamp !== "string")
    throw new Error("timestamp must be a string");
  if (channel === "agent chat") {
    const match = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(timestamp);
    if (!match) throw new Error("Chat timestamp must be MM:SS or HH:MM:SS");
    return match[3] == null
      ? Number(match[1]) * 60 + Number(match[2])
      : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error("Call timestamp must be ISO 8601 with timezone");
  }
  return Date.parse(timestamp) / 1000;
}
export function normalizeConversation(input) {
  if (
    !input ||
    typeof input.conversation_id !== "string" ||
    !input.conversation_id.trim() ||
    !Array.isArray(input.messages ?? input.transcript)
  )
    throw new Error("Invalid Conversation");
  if (!CHANNELS.has(input.channel))
    throw Error(`Unknown channel ${input.channel} in ${input.conversation_id}`);
  let first = 0,
    previous = -Infinity;
  const messages = (input.messages ?? input.transcript).map((message, idx) => {
    const id = `m${String(idx + 1).padStart(3, "0")}`;
    if (!SPEAKERS.has(message?.speaker))
      throw Error(
        `Unknown speaker ${message?.speaker} in ${input.conversation_id} ${id}`,
      );
    if (typeof message.text !== "string") throw new Error("Invalid message");
    const seconds = timestampSeconds(message.timestamp, input.channel);
    if (idx === 0) first = seconds;
    if (seconds < previous)
      throw new Error(
        `${input.conversation_id} ${id}: messages must be chronological`,
      );
    previous = seconds;
    return {
      id,
      idx,
      timestamp: message.timestamp,
      offset_sec: seconds - first,
      speaker: SPEAKERS.get(message.speaker),
      text: message.text,
    };
  });
  return {
    conversation_id: input.conversation_id,
    channel: CHANNELS.get(input.channel),
    language: input.language ?? null,
    audio_url: input.audio_url ?? null,
    messages,
  };
}
export function getConversation(db, id) {
  const row = db
    .prepare(
      "SELECT conversation_id, channel, language, audio_url FROM conversations WHERE conversation_id=?",
    )
    .get(id);
  if (!row) return null;
  return {
    ...row,
    messages: db
      .prepare(
        "SELECT id, idx, timestamp, offset_sec, speaker, text FROM messages WHERE conversation_id=? ORDER BY idx",
      )
      .all(id)
      .map((m) => ({ ...m })),
  };
}
export function saveConversations(db, inputs, groupId) {
  const conversations = inputs.map(normalizeConversation);
  if (
    new Set(conversations.map((c) => c.conversation_id)).size !==
    conversations.length
  )
    throw new Error("Duplicate conversation_id");
  return transaction(db, () => {
    const conflicts = conversations
      .filter((c) => {
        const existing = getConversation(db, c.conversation_id);
        return existing && JSON.stringify(existing) !== JSON.stringify(c);
      })
      .map((c) => c.conversation_id);
    if (conflicts.length)
      throw Object.assign(
        fail(
          409,
          `Conversations already exist with different content: ${conflicts.join(", ")}`,
        ),
        { conflict_ids: conflicts },
      );
    for (const c of conversations) {
      const existing = getConversation(db, c.conversation_id);
      if (existing) continue;
      db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)").run(
        c.conversation_id,
        groupId,
        c.channel,
        c.language,
        c.audio_url,
        now(),
      );
      const insert = db.prepare(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const m of c.messages)
        insert.run(
          c.conversation_id,
          m.id,
          m.idx,
          m.timestamp,
          m.offset_sec,
          m.speaker,
          m.text,
        );
    }
    return conversations.length;
  });
}
export async function importGroup(
  db,
  groupId,
  { url = process.env.ORG_API_URL, fetchImpl = fetch } = {},
) {
  if (typeof groupId !== "string" || !groupId.trim())
    throw Object.assign(new Error("group_id is required"), { status: 400 });
  let endpoint;
  try {
    if (typeof url !== "string" || !url.trim()) throw Error();
    endpoint = new URL(url);
    if (!["https:", "http:"].includes(endpoint.protocol)) throw Error();
  } catch {
    throw fail(503, "ORG_API_URL is missing or invalid");
  }
  endpoint.searchParams.set("group_id", groupId);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(30000),
    });
  } catch (cause) {
    if (["TimeoutError", "AbortError"].includes(cause.name))
      throw fail(504, "Organizers API timeout");
    throw fail(502, `Organizers API network error: ${cause.message}`);
  }
  if (!response.ok) throw fail(502, `Organizers API HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    if (["TimeoutError", "AbortError"].includes(cause.name))
      throw fail(504, "Organizers API timeout");
    throw fail(502, "Organizers API returned invalid JSON");
  }
  if (body?.isSuccess !== true)
    throw fail(
      502,
      `Organizers API returned isSuccess != true: ${typeof body?.error === "string" ? body.error : JSON.stringify(body?.error ?? null)}`,
    );
  const list =
    body.data?.records ??
    body.conversations ??
    body.data?.conversations ??
    body.data;
  if (!Array.isArray(list))
    throw fail(502, "Organizers API must return a conversations array");
  try {
    return saveConversations(db, list, groupId);
  } catch (cause) {
    if (cause.status === 409) throw cause;
    throw fail(502, `Invalid import: ${cause.message}`);
  }
}
