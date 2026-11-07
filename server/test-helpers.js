import { readFileSync } from "node:fs";
import { openDatabase } from "./db.js";
import { createApp } from "./app.js";
import { saveConversations } from "./import.js";
const conversation = JSON.parse(
  readFileSync(new URL("../shared/mocks/conversation.json", import.meta.url)),
);
export async function fixture(fn, options) {
  const db = openDatabase(":memory:");
  saveConversations(db, [conversation], "DEV");
  const server = createApp(db, options).listen(0);
  await new Promise((r) => server.once("listening", r));
  const request = async (path, body) => {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(request, db);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
}
