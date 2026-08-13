"use strict";
/**
 * שרת אחסון זמני + מפעיל הורדות של SaveBridge.
 *
 * מקבל בקשת הורדה (URL של YouTube), מריץ אותה דרך שרת SaveBridge
 * (הראלי extsync.com/sb-relay — אותו שרת שהתוסף משתמש בו), שומר את
 * הקובץ בתיקיית storage/ ומספק אותו. בהמשך: משלוח ל-Drive או במייל.
 *
 * API:
 *   POST /api/download          {url, format, quality} -> {jobId}       (מתחיל הורדה, לא ממתין)
 *   GET  /api/jobs/:id          -> סטטוס ההורדה
 *   POST /api/save              {url, format, quality} -> {ok, file}    (ממתין עד הסוף ושומר לדיסק)
 *   GET  /api/files/:name       -> הקובץ השמור (אופציונלי, עם ?token=)
 *
 * הפעלה:  node storage-server.js            (PORT ברירת מחדל 9796)
 * בדיקה:  node storage-server.js --test <url>
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sb = require("./savebridge-client");
const { exportCookies } = require("./cookies");

const PORT = Number(process.env.SB_PORT || 9796);
const STORAGE_DIR = path.join(__dirname, "storage");
const DATA_DIR = path.join(__dirname, "data");
const FILE_TTL_MS = 60 * 60 * 1000; // שעה
const ACCESS_TOKEN = process.env.STORAGE_TOKEN || "";

// סוכן העוגיות (במחשב האישי) דוחף לכאן את עוגיות היוטיוב.
// אם לא הוגדר אחרת, הקליינט קורא אותן מקובץ האחסון הזה.
fs.mkdirSync(DATA_DIR, { recursive: true });
const COOKIES_STORE = process.env.SB_COOKIES_STORE || path.join(DATA_DIR, "cookies.txt");
if (!process.env.SB_COOKIES_FILE) process.env.SB_COOKIES_FILE = COOKIES_STORE;
const SYNC_TOKEN = process.env.SB_SYNC_TOKEN || "";

const FORMAT_EXT = { audio: "mp3", low_phone: "3gp", video: "mp4" };

// ---------- storage ----------

fs.mkdirSync(STORAGE_DIR, { recursive: true });

function safeName(name) {
  if (!name) return "";
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/^[.\s]+/, "").trim();
}

function fileExt(format) {
  return FORMAT_EXT[format] || "mp4";
}

function jobFilename(job) {
  const base = safeName(job?.fileName || job?.title || "video");
  if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  return `${base || "video"}.${fileExt(job?.format)}`;
}

function cleanupOldFiles() {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const f of fs.readdirSync(STORAGE_DIR)) {
    const p = path.join(STORAGE_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

/** רשום מול שרת SaveBridge וקבל טוקן (נשמר בזיכרון). */
let cachedToken = null;
let tokenInFlight = null;
async function ensureToken() {
  if (cachedToken) return cachedToken;
  if (!tokenInFlight) {
    tokenInFlight = (async () => {
      const token = await sb.register();
      if (token) cachedToken = token;
      return token;
    })().finally(() => (tokenInFlight = null));
  }
  return tokenInFlight;
}

// ---------- helpers ----------

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, code, message) {
  json(res, code, { ok: false, error: { message } });
}

async function startAndWait(input) {
  const token = await ensureToken();
  if (!token) return { ok: false, error: { message: "לא ניתן להתחבר לשרת ההורדות (register נכשל)" } };
  const cookieRes = await exportCookies();
  if (!cookieRes.ok) {
    console.warn(`[cookies] ${cookieRes.error}`);
  }
  const started = await sb.startDownload({
    ...input,
    cookies: cookieRes.ok ? cookieRes.cookies : undefined,
    token,
  });
  if (!started.ok) return started;
  const wait = await sb.waitForJob(started.jobId, { token });
  if (!wait.ok) return wait;
  if (wait.job.status !== "completed" || !wait.job.hasFile) {
    return { ok: false, error: { message: `ההורדה נכשלה: ${wait.job.error?.message || wait.job.status}` } };
  }
  const name = jobFilename(wait.job);
  const target = path.join(STORAGE_DIR, name);
  const res = await fetch(sb.fileUrl(started.jobId, token));
  if (!res.ok) return { ok: false, error: { message: `הורדת הקובץ מהשרת נכשלה (HTTP ${res.status})` } };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return {
    ok: true,
    job: wait.job,
    file: { name, size: buf.length, path: target },
  };
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "download") {
    cleanupOldFiles();
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendError(res, 400, "בקשה לא תקינה — יש לשלוח JSON");
    }
    const urlInput = String(body.url || "").trim();
    if (!urlInput) return sendError(res, 400, "חסרה כתובת (url)");
    const format = ["video", "audio", "low_phone"].includes(body.format) ? body.format : "audio";
    const quality = String(body.quality || "audio_best");
    const token = await ensureToken();
    if (!token) return sendError(res, 502, "לא ניתן להתחבר לשרת ההורדות");
    const cookieRes = await exportCookies();
    if (!cookieRes.ok) console.warn(`[cookies] ${cookieRes.error}`);
    const started = await sb.startDownload({
      url: urlInput,
      format,
      quality,
      cookies: cookieRes.ok ? cookieRes.cookies : undefined,
      token,
    });
    if (!started.ok) return json(res, 500, started);
    return json(res, 202, { ok: true, jobId: started.jobId, status: "started" });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts[2]) {
    const token = await ensureToken();
    if (!token) return sendError(res, 502, "לא ניתן להתחבר לשרת ההורדות");
    const st = await sb.getJob(parts[2], { token });
    if (!st.ok) return json(res, 404, st);
    return json(res, 200, { ok: true, job: st.job });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "save") {
    cleanupOldFiles();
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendError(res, 400, "בקשה לא תקינה — יש לשלוח JSON");
    }
    const urlInput = String(body.url || "").trim();
    if (!urlInput) return sendError(res, 400, "חסרה כתובת (url)");
    const format = ["video", "audio", "low_phone"].includes(body.format) ? body.format : "audio";
    const quality = String(body.quality || "audio_best");
    const result = await startAndWait({ url: urlInput, format, quality });
    if (!result.ok) return json(res, 500, result);
    const { name, size, path: p } = result.file;
    json(res, 200, { ok: true, file: { name, size, path: p } });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "cookies") {
    // קבלת עוגיות מהסוכן שבמחשב האישי (דורש טוקן משותף)
    if (!SYNC_TOKEN || req.headers["x-sync-token"] !== SYNC_TOKEN) {
      return sendError(res, 403, "טוקן סנכרון שגוי");
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendError(res, 400, "בקשה לא תקינה");
    }
    if (!body.cookies || typeof body.cookies !== "string") {
      return sendError(res, 400, "חסר שדה cookies");
    }
    fs.writeFileSync(COOKIES_STORE, body.cookies);
    console.log(`[cookies] עודכנו (${body.cookies.length} תווים) -> ${COOKIES_STORE}`);
    return json(res, 200, { ok: true, updatedAt: new Date().toISOString() });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "files" && parts[2]) {
    if (ACCESS_TOKEN && url.searchParams.get("token") !== ACCESS_TOKEN) {
      return sendError(res, 403, "טוקן שגוי");
    }
    const p = path.join(STORAGE_DIR, parts[2]);
    if (!p.startsWith(STORAGE_DIR) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return sendError(res, 404, "הקובץ לא נמצא (או פג תוקפו)");
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(p).size });
    fs.createReadStream(p).pipe(res);
    return;
  }

  if (req.method === "GET" && (parts[0] === "health" || parts[0] === "api")) {
    cleanupOldFiles();
    const pong = await sb.ping();
    return json(res, 200, { ok: true, savebridge: pong, storage: STORAGE_DIR, token: Boolean(cachedToken) });
  }

  sendError(res, 404, "לא נמצא מסלול");
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--test") {
    const url = args[1];
    if (!url) {
      console.error('שימוש: node storage-server.js --test <url> [format] [quality]');
      process.exit(1);
    }
    const format = args[2] || "audio";
    const quality = args[3] || "audio_best";
    console.log(`[test] מוריד: ${url} (${format}/${quality})`);
    const started = Date.now();
    const result = await startAndWait({ url, format, quality });
    if (!result.ok) {
      console.error("[test] נכשל:", JSON.stringify(result.error, null, 2));
      process.exit(1);
    }
    console.log(`[test] הצלחה אחרי ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`[test] קובץ: ${result.file.path} (${(result.file.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[test] מטא:`, JSON.stringify({ title: result.job.title, format: result.job.format, quality: result.job.quality }));
    return;
  }

  http
    .createServer(handle)
    .listen(PORT, process.env.SB_HOST || "127.0.0.1", () => {
      console.log(`[storage-server] מאזין על http://127.0.0.1:${PORT}`);
      console.log(`[storage-server] אחסון: ${STORAGE_DIR}`);
      sb.ping().then((p) => console.log(`[storage-server] שרת SaveBridge: ${p.reachable ? `מחובר (yt-dlp ${p.ytDlp})` : "לא זמין"}`));
    });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { startAndWait, ensureToken, STORAGE_DIR, handle };
