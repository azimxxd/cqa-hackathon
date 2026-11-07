// One journal row per HTTP attempt, including failed and malformed responses.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function requestJson({
  provider,
  url,
  init,
  model,
  maxAttempts,
  maxBackoffMs,
  baseBackoffMs,
  usage,
  headersForAttempt,
  rotateKey,
}) {
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(maxBackoffMs) ||
    maxBackoffMs < 0
  )
    throw Error(`Invalid ${provider} retry configuration`);
  const calls = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();
    const call = {
      model,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      raw_response: "",
    };
    let response,
      error,
      rotate = false;
    try {
      response = await fetch(url, {
        ...init,
        ...(headersForAttempt ? { headers: headersForAttempt(attempt) } : {}),
        signal: AbortSignal.timeout(provider === "gemini" ? 180000 : 600000),
      });
      const raw = await response.text();
      call.raw_response = raw;
      if (!response.ok) {
        rotate = rotateKey?.(response.status, attempt) === true;
        const retryable = response.status === 429 || response.status >= 500;
        throw Object.assign(
          Error(
            `${provider === "gemini" ? "Gemini" : "Ollama"} HTTP ${response.status}: ${raw.slice(0, 300)}`,
          ),
          { status: response.status, retryable, fatal: !retryable, provider },
        );
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw Object.assign(Error(`${provider}: invalid JSON response`), {
          status: response.status,
          provider,
          fatal: true,
        });
      }
      Object.assign(call, usage(json));
      call.latency_ms = Date.now() - start;
      calls.push(call);
      return { json, calls };
    } catch (cause) {
      error = cause;
      if (error.provider == null)
        Object.assign(error, {
          provider,
          status: response?.status ?? 0,
          retryable: true,
        });
      call.latency_ms = Date.now() - start;
      if (!call.raw_response) call.raw_response = error.message;
      calls.push(call);
      if (rotate && attempt + 1 < maxAttempts) continue;
      if (error.retryable !== true || attempt + 1 === maxAttempts) {
        error.calls = calls;
        throw error;
      }
    }
    const retryAfter = response?.headers.get("retry-after");
    const seconds = retryAfter == null ? NaN : Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAfter && Number.isFinite(Date.parse(retryAfter))
        ? Math.max(0, Date.parse(retryAfter) - Date.now())
        : baseBackoffMs * 2 ** attempt;
    await sleep(Math.max(0, Math.min(maxBackoffMs, delay)));
  }
}
