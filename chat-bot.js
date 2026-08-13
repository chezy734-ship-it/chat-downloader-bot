"use strict";
/**
 * בוט Google Chat — מקבל webhook, מגיב ל-@mention, מוריד ומשלח.
 *
 * איך זה עובד:
 *   Google Chat (תגית) → POST / (עם verification token)
 *     1. אימות הטוקן + allowlist (רק מי שבחרת)
 *     2. חילוץ קישור יוטיוב מההודעה
 *     3. תשובה מיידית: "מתחיל להוריד..."
 *     4. רקע: /api/save בשרת האחסון → משלוח (Drive ברירת מחדל) → הודעה סופית
 *     5. ההודעה הסופית נשלחת דרך Incoming Webhook (שמוגדר במרחב) —
 *        כי בלי Service Account (Workspace) אין דרך רשמית לענות
 *        אסינכרונית "בשם הבוט" בחשבון אישי.
 *
 * Env:
 *   SB_BOT_PORT=9795
 *   CHAT_VERIFICATION_TOKEN=<הטוקן מה-Cloud Console>
 *   ALLOWED_USERS="email1@x.com,email2@y.com"   (או "users/...", או "*")
 *   INCOMING_WEBHOOK_URL=<URL של Incoming Webhook במרחב>
 *   STORAGE_URL=http://127.0.0.1:9796
 *   DELIVERY_DEFAULT=drive|gmail
 *   GMAIL_TO=<כתובת קבועה> (לאופציית gmail)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.SB_BOT_PORT || 9795);
const VERIFY_TOKEN = process.env.CHAT_VERIFICATION_TOKEN || "";
const ALLOWED = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const WEBHOOK_URL = process.env.INCOMING_WEBHOOK_URL || "";
const STORAGE_URL = (process.env.STORAGE_URL || "http://127.0.0.1:9796").replace(/\/+$/, "");
const DELIVERY_DEFAULT = process.env.DELIVERY_DEFAULT || "drive";
const GMAIL_TO = process.env.GMAIL_TO || "";

const oauth = require("./oauth");
const { deliverToDrive, deliverViaGmail } = require("./delivery");

// ---------- עזרים ----------

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

function youtubeUrl(text) {
  const m = String(text || "").match(/(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (!m) return null;
  const id = m[5];
  const base = m[2] === "www." || m[2] === "m." ? `www.${m[3]}` : m[3];
  if (m[3].includes("youtu.be")) return `https://youtu.be/${id}`;
  if (m[3].includes("shorts")) return `https://www.youtube.com/shorts/${id}`;
  return `https://www.youtube.com/watch?v=${id}`;
}

function isAllowed(event) {
  const senderName = (event.message?.sender?.name || event.user?.name || "").toLowerCase();
  const email = (event.user?.email || event.message?.sender?.email || "").toLowerCase();
  if (ALLOWED.includes("*")) return true;
  return ALLOWED.includes(email) || ALLOWED.includes(senderName);
}

function replySync(res, text) {
  // תשובה סינכרונית — גוגל מציגה אותה בשם הבוט
  return json(res, 200, { text });
}

async function postToWebhook(text) {
  if (!WEBHOOK_URL) {
    console.log("[bot] אין INCOMING_WEBHOOK_URL — לא ניתן לשלוח הודעה סופית");
    return false;
  }
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}

// ---------- התהליך (רקע) ----------

async function runDownloadAndDeliver({ url, requesterEmail, threadLabel }) {
  try {
    const saveRes = await fetch(`${STORAGE_URL}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, format: "audio", quality: "audio_best" }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const saveJson = await saveRes.json();
    if (!saveRes.ok || !saveJson.ok) {
      await postToWebhook(`❌ ההורדה נכשלה: ${saveJson?.error?.message || saveJson?.message || "שגיאה לא ידועה"}`);
      return;
    }
    const filePath = saveJson.file.path;
    const fileName = saveJson.file.name;

    let resultText;
    if (DELIVERY_DEFAULT === "gmail" && (GMAIL_TO || requesterEmail)) {
      const to = GMAIL_TO || requesterEmail;
      const sent = await deliverViaGmail(oauth, { filePath, fileName, to });
      resultText = `📧 נשלח במייל ל-${sent.to}`;
    } else {
      const up = await deliverToDrive(oauth, { filePath, fileName });
      resultText = `📁 הקובץ שלך: ${up.link}`;
    }

    // ניקוי הקובץ הזמני אחרי המשלוח
    try {
      fs.unlinkSync(filePath);
    } catch {}

    await postToWebhook(`✅ ההורדה הסתיימה: *${fileName}* — ${resultText}`);
  } catch (e) {
    console.log(`[bot] שגיאה בתהליך: ${e.message}`);
    await postToWebhook(`❌ משהו נכשל: ${e.message.slice(0, 200)}`);
  }
}

// ---------- handler ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, bot: true });
  }

  if (req.method !== "POST" || url.pathname !== "/") {
    return json(res, 404, { error: "לא נמצא" });
  }

  // 1. אימות verification token (Google שולח: Authorization: Bearer <token>)
  const auth = req.headers.authorization || "";
  if (!VERIFY_TOKEN || auth !== `Bearer ${VERIFY_TOKEN}`) {
    console.log(`[bot] ❌ אימות נכשל (Authorization: ${auth.slice(0, 30)}...)`);
    return json(res, 403, { error: "unauthorized" });
  }

  let event;
  try {
    event = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "bad json" });
  }

  // רק הודעות
  if (event.type !== "MESSAGE") return json(res, 200, {});

  const text = event.message?.argumentText || event.message?.text || "";
  const requesterEmail = event.user?.email || event.message?.sender?.email || "";

  // 2. allowlist
  if (!isAllowed(event)) {
    console.log(`[bot] ⛔ נחסם משתמש שאינו מורשה: ${requesterEmail || event.user?.name}`);
    return replySync(res, "אין לך הרשאה להשתמש בבוט הזה.");
  }

  // 3. קישור יוטיוב
  const urlMatch = youtubeUrl(text);
  if (!urlMatch) {
    return replySync(res, "שלח קישור יוטיוב ואני אוריד לך אותו 🎵\nלדוגמה: `@הבוט https://youtu.be/xxxx`");
  }

  // 4. אישור מיידי + 5. תהליך ברקע
  replySync(res, `מתחיל להוריד את *${urlMatch}*... 🎧 אחזור עם התוצאה`);
  setTimeout(() => {
    runDownloadAndDeliver({ url: urlMatch, requesterEmail }).catch((e) =>
      console.log(`[bot] שגיאה חריגה: ${e.message}`)
    );
  }, 50);

  return;
}

function main() {
  http
    .createServer(handle)
    .listen(PORT, process.env.SB_HOST || "127.0.0.1", () => {
      console.log(`[bot] מאזין על http://127.0.0.1:${PORT}`);
      console.log(`[bot] token אימות: ${VERIFY_TOKEN ? "מוגדר" : "⚠️ חסר — הגדר CHAT_VERIFICATION_TOKEN"}`);
      console.log(`[bot] allowlist: ${ALLOWED.join(", ") || "⚠️ ריק — אף אחד לא יורשה (או * לכולם)"}`);
    });
}

if (require.main === module) main();

module.exports = { handle, PORT };
