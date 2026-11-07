import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_AUDIO_BYTES } from "../ai/transcription.js";
import { fail } from "./http.js";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const defaultDirectory = fileURLToPath(new URL("../data/audio", import.meta.url));

async function audioFile(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!info?.isFile()) return null;
  if (!info.size || info.size > MAX_AUDIO_BYTES)
    throw fail(413, "Invalid recording size");
  return { path, size: info.size };
}

async function publicUrl(url) {
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw fail(502, "Invalid recording URL");
  // Resolve IPv4 only and reject local, reserved and private networks.
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  })) throw fail(502, "Invalid recording host");
  return addresses[0].address;
}

async function fetchAudio(url, { signal }) {
  const address = await publicUrl(url);
  return new Promise((resolve, reject) => {
    const request = get(url, {
      signal,
      family: 4,
      headers: { "User-Agent": "Mozilla/5.0" },
      lookup: (_host, _options, callback) => callback(null, address, 4),
    }, (response) => resolve({
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      headers: new Headers(response.headers),
      body: Readable.toWeb(response),
    }));
    request.on("error", reject);
  });
}

async function readBody(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw fail(413, "Recording response is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw fail(413, "Recording response is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

const isMp3 = (bytes) => bytes.length >= 4 &&
  (bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0));
const mp3Types = ["audio/mpeg", "audio/mp3", "audio/mpeg3", "application/octet-stream"];

async function download(source, fetcher) {
  let url = new URL(source);
  const signal = AbortSignal.timeout(45000);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetcher(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || response.status === 206) {
      await response.body?.cancel();
      throw fail(502, `Recording download failed (HTTP ${response.status})`);
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (mp3Types.includes(type)) {
      const bytes = await readBody(response, MAX_AUDIO_BYTES);
      if (isMp3(bytes)) return bytes;
    } else if (type === "application/json" || type === "text/html") {
      const body = (await readBody(response, Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4096)).toString();
      if (type === "application/json") {
        const json = JSON.parse(body);
        const wrapper = json?.body ?? json ?? {};
        const content = wrapper["$content"];
        if (typeof content === "string" && mp3Types.includes(wrapper["$content-type"]?.split(";")[0].toLowerCase())) {
          const bytes = Buffer.from(content, "base64");
          if (bytes.length <= MAX_AUDIO_BYTES && isMp3(bytes)) return bytes;
        }
        const target = wrapper.audio_url ?? wrapper.url ?? wrapper.downloadUrl ?? wrapper.download_url;
        if (typeof target === "string") {
          url = new URL(target, url);
          continue;
        }
      }
      const target = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(body)?.[1];
      if (target) {
        url = new URL(target.replace(/&amp;|&#38;/gi, "&"), url);
        continue;
      }
    } else {
      await response.body?.cancel();
    }
    throw fail(502, "Recording response is not an MP3");
  }
  throw fail(502, "Recording download exceeded the redirect limit");
}

export function createAudioStore({ directory = defaultDirectory, fetcher = fetchAudio } = {}) {
  const pending = new Map();
  function paths({ conversation_id: id, audio_url: url }) {
    const name = /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id) ? id : hash(id);
    return {
      local: resolve(directory, `${name}.mp3`),
      remote: url ? resolve(directory, `remote-${hash(JSON.stringify([id, url]))}.mp3`) : null,
    };
  }
  async function find(conversation) {
    const { local, remote } = paths(conversation);
    return await audioFile(local) ?? (remote && await audioFile(remote));
  }
  async function load(conversation) {
    const file = await find(conversation);
    if (file) return file;
    const { remote } = paths(conversation);
    if (!remote) throw fail(404, "Recording is unavailable");
    if (!pending.has(remote)) {
      const task = (async () => {
        const temporary = `${remote}.${randomUUID()}.tmp`;
        try {
          const bytes = await download(conversation.audio_url, fetcher);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await rename(temporary, remote);
          return { path: remote, size: bytes.length };
        } catch (error) {
          if ([413, 502].includes(error.status)) throw error;
          throw fail(502, "Recording download failed");
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
          pending.delete(remote);
        }
      })();
      pending.set(remote, task);
    }
    return pending.get(remote);
  }
  return { find, load };
}

export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1]) {
    if (end <= 0) return null;
    return [Math.max(0, size - end), size - 1];
  }
  const start = Number(match[1]);
  return start < size && start <= end ? [start, Math.min(end, size - 1)] : null;
}
