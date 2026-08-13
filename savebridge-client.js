"use strict";
/**
 * SaveBridge protocol client.
 *
 * Speaks the exact same API the SaveBridge Chrome extension (extension-1)
 * uses, so our bot server can trigger YouTube downloads without needing
 * the browser or the extension to be open. The protocol was taken from
 * extension-1/background.js (CLIENT_VERSION / CLIENT_SECRET / endpoints).
 *
 * Flow:
 *   1. register()  -> POST /api/hello  (HMAC-signed) -> bearer token
 *   2. start()     -> POST /api/start  (HMAC-signed + token) -> jobId
 *   3. getJob()    -> GET  /api/jobs/:id  -> status / progress
 *   4. fileUrl()   -> GET  /api/jobs/:id/file?token=...  -> the media file
 */

const crypto = require("crypto");

const SERVER_URL = "https://extsync.com/sb-relay";
const CLIENT_VERSION = "0.4.4";
// מפתח ה-HMAC של קליינט SaveBridge — מועבר עכשיו מסביבה כדי שלא ייחשף
// בקוד ציבורי (למשל repo ציבורי על Render). לריצה מקומית מגדירים אותו ב-env.
const CLIENT_SECRET = process.env.SB_RELAY_SECRET || "";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

function trimBase(url) {
  return String(url || SERVER_URL).replace(/\/+$/, "");
}

/** HMAC-SHA256 signature over `${CLIENT_VERSION}\n${ts}\n${action}` */
function signHeaders(action) {
  const ts = String(Date.now());
  const sig = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(`${CLIENT_VERSION}\n${ts}\n${action}`)
    .digest("hex");
  return { "X-SaveBridge-Ver": CLIENT_VERSION, "X-SaveBridge-Ts": ts, "X-SaveBridge-Sig": sig };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** GET /api/ping — is the download server up? */
async function ping(base = SERVER_URL, timeoutMs = 8000) {
  try {
    const res = await fetch(`${trimBase(base)}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 418) return { reachable: false };
    const json = await res.json().catch(() => null);
    return { reachable: res.ok, ytDlp: json?.ytDlp ?? null, ffmpeg: Boolean(json?.ffmpeg) };
  } catch {
    return { reachable: false };
  }
}

/** POST /api/hello — register and get a bearer token (like the extension does). */
async function register(base = SERVER_URL, timeoutMs = 8000) {
  try {
    const res = await fetch(`${trimBase(base)}/api/hello`, {
      method: "POST",
      headers: { ...signHeaders("hello") },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return typeof json?.token === "string" && json.token ? json.token : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/start — create a download job.
 * format:  "video" | "audio" | "low_phone"
 * quality: "best" | "1080" | "720" | "480" | "audio_best"
 */
async function startDownload({ url, title = "", format = "audio", quality = "audio_best", cookies, pubKey, token, base = SERVER_URL }) {
  const res = await fetch(`${trimBase(base)}/api/start`, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      ...signHeaders("download"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, title, format, quality, cookies, pubKey }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) return { ok: false, error: { code: "E_UNPAIRED", message: "לא מחובר לשרת ההורדות" } };
  if (res.status === 429) return { ok: false, error: { code: "E_RATE_LIMITED", message: "יותר מדי הורדות ברצף — נסה שוב בעוד רגע" } };
  if (res.status === 418) return { ok: false, error: { code: "E_SERVER_UNREACHABLE", message: `השרת חסום (HTTP ${res.status})` } };
  const json = await res.json().catch(() => null);
  if (res.ok && json?.jobId) return { ok: true, jobId: json.jobId };
  return { ok: false, error: { code: "E_DOWNLOAD_FAILED", message: `השרת החזיר שגיאה (HTTP ${res.status})`, detail: JSON.stringify(json ?? null).slice(0, 500) } };
}

/** GET /api/jobs/:id — job status. */
async function getJob(jobId, { token, base = SERVER_URL }) {
  const res = await fetch(`${trimBase(base)}/api/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { ok: false, error: { code: "E_JOB_NOT_FOUND", message: `לא נמצאה הורדה (HTTP ${res.status})` } };
  const job = await res.json().catch(() => null);
  if (job && typeof job.status === "string") return { ok: true, job };
  return { ok: false, error: { code: "E_UNKNOWN", message: "תשובה לא צפויה מהשרת" } };
}

/** URL of the finished media file (requires the bearer token). */
function fileUrl(jobId, token, base = SERVER_URL) {
  return `${trimBase(base)}/api/jobs/${encodeURIComponent(jobId)}/file?token=${encodeURIComponent(token)}`;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** Convenience: start a job and poll until it reaches a terminal status. */
async function waitForJob(jobId, { token, base = SERVER_URL, intervalMs = 1500, timeoutMs = 10 * 60 * 1000, onTick } = {}) {
  const started = Date.now();
  for (;;) {
    const res = await getJob(jobId, { token, base });
    if (!res.ok) return res;
    const job = res.job;
    if (onTick) onTick(job);
    if (isTerminal(job.status)) return { ok: true, job };
    if (Date.now() - started > timeoutMs) {
      return { ok: false, error: { code: "E_TIMEOUT", message: "ההורדה ארכה זמן רב מדי" } };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = {
  SERVER_URL,
  ping,
  register,
  startDownload,
  getJob,
  waitForJob,
  fileUrl,
  isTerminal,
};
