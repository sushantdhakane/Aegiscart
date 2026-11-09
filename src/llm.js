// OpenRouter client (OpenAI-compatible chat completions).
// Default model: Nemotron 3 Ultra (free). Used only by src/agent-brain.js for two
// narrow jobs: reading the buyer's goal and picking among options that already fit.
// It has no access to prices, stock, policy or Razorpay, and its output is
// validated by code before anything uses it. On any failure the caller falls
// back to the built-in rules, so checkout never depends on the model.

const API_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
// Reasoning is optional: it improves hard problems but adds latency. Off by default
// because this task is extraction + a small choice. Set OPENROUTER_REASONING=true to enable.
const REASONING = /^(1|true|yes|on)$/i.test(process.env.OPENROUTER_REASONING || "");
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 40000);
const MAX_RETRY_WAIT_MS = Number(process.env.OPENROUTER_MAX_RETRY_WAIT_MS || 3000);
const COOLDOWN_MS = Number(process.env.OPENROUTER_COOLDOWN_MS || 60000);

let cooldownUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestOnce(messages, maxTokens) {
  const body = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens };
  if (REASONING) body.reasoning = { enabled: true };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, "X-Title": "AegisCart" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    err.status = res.status;
    const ra = Number(res.headers.get("retry-after"));
    err.retryAfterMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null;
    throw err;
  }
  return res.json();
}

/** Pull a JSON object out of model text (tolerates code fences and stray prose). */
function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, "");
  const i = cleaned.indexOf("{"), j = cleaned.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(cleaned.slice(i, j + 1)); } catch { return null; }
}

/**
 * One system + user exchange that must return a JSON object.
 * Returns { ok:true, json, model, ms } or { ok:false, reason, error }.
 */
async function chatJson({ system, user, maxTokens = 1500 }) {
  if (!API_KEY) return { ok: false, reason: "no_api_key" };
  if (Date.now() < cooldownUntil) {
    return { ok: false, reason: "rate_limited_cooldown", error: `model paused for ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s after a rate limit` };
  }
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const started = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await requestOnce(messages, maxTokens);
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      const content = msg && typeof msg.content === "string" ? msg.content.trim() : "";
      if (!content) return { ok: false, reason: "empty_response", error: "model returned no content" };
      const json = extractJson(content);
      if (!json) return { ok: false, reason: "bad_json", error: "model did not return a JSON object" };
      return { ok: true, json, model: MODEL, ms: Date.now() - started };
    } catch (err) {
      lastErr = err;
      const retryable = err.status === 429 || err.status >= 500 || err.name === "TimeoutError";
      const wait = err.retryAfterMs == null ? 1000 : err.retryAfterMs;
      if (attempt === 0 && retryable && wait <= MAX_RETRY_WAIT_MS) { await sleep(wait); continue; }
      break;
    }
  }
  if (lastErr.status === 429) cooldownUntil = Date.now() + COOLDOWN_MS;
  return { ok: false, reason: lastErr.status === 429 ? "rate_limited" : "llm_error", error: String(lastErr.message || lastErr) };
}

module.exports = { chatJson, extractJson, isConfigured: Boolean(API_KEY), model: MODEL };
