import { now, transaction } from "./db.js";

export function timestampSeconds(timestamp, channel) {
  if (typeof timestamp !== "string")
    throw new Error("timestamp must be a string");
  if (channel === "agent chat") {
    const match = /^(\d+):([0-5]\d)$/.exec(timestamp);
    if (!match) throw new Error("Chat timestamp must be MM:SS");
    return Number(match[1]) * 60 + Number(match[2]);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ||
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
    !["agent chat", "voice call"].includes(input.channel) ||
    !Array.isArray(input.messages)
  )
    throw new Error("Invalid Conversation");
  let first = 0,
    previous = -Infinity;
  const messages = input.messages.map((message, idx) => {
    if (
      !["client", "operator", "bot", "system"].includes(message.speaker) ||
      typeof message.text !== "string"
    )
      throw new Error("Invalid message");
    const seconds = timestampSeconds(message.timestamp, input.channel);
    if (idx === 0) first = seconds;
    if (seconds < previous) throw new Error("Messages must be chronological");
    previous = seconds;
    return {
      id: `m${String(idx + 1).padStart(3, "0")}`,
      idx,
      timestamp: message.timestamp,
      offset_sec: seconds - first,
      speaker: message.speaker,
      text: message.text,
    };
  });
  return {
    conversation_id: input.conversation_id,
    channel: input.channel,
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
    for (const c of conversations) {
      const existing = getConversation(db, c.conversation_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(c))
          throw new Error(
            `Conversation ${c.conversation_id} already exists with different content`,
          );
        continue;
      }
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
  if (!url)
    throw Object.assign(new Error("ORG_API_URL is not configured"), {
      status: 503,
    });
  const endpoint = new URL(url);
  endpoint.searchParams.set("group_id", groupId);
  const response = await fetchImpl(endpoint, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`Organizers API HTTP ${response.status}`), {
      status: 502,
    });
  const body = await response.json();
  if (body.isSuccess !== true)
    throw Object.assign(
      new Error("Organizers API returned isSuccess != true"),
      { status: 502 },
    );
  const list = body.conversations ?? body.data?.conversations ?? body.data;
  if (!Array.isArray(list))
    throw Object.assign(
      new Error("Organizers API must return a conversations array"),
      { status: 502 },
    );
  try {
    return saveConversations(db, list, groupId);
  } catch (cause) {
    throw Object.assign(new Error(`Invalid import: ${cause.message}`), {
      status: 502,
    });
  }
}
