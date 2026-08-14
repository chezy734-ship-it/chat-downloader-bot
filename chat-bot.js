"use strict";
/**
 * בוט Google Chat — מקבל webhook, מגיב ל-@mention, מוריד ומשלח.
 *
 * איך זה עובד:
 *   Google Chat (תגית) → POST / (עם verification token)
 *     1. אימות הטוקן + allowlist (רק מי שבחרת)
 *     2. פענוח הפקודה: שיר / סרטון / עזרה / טלגרם (בהמשך) — או קישור בלבד
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
const crypto = require("crypto");

const PORT = Number(process.env.SB_BOT_PORT || 9795);
const VERIFY_TOKEN = process.env.CHAT_VERIFICATION_TOKEN || "";
// ה-URL שבו ה-Chat app מוגדר (audience ב-ID token של גוגל)
const CHAT_APP_URL = (process.env.CHAT_APP_URL || "https://chat-downloader-bot.onrender.com/").replace(/\/+$/, "");
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

// ---------- אימות ID token של Google Chat ----------
// גוגל שולחת ב-Authorization header ID token חתום (OIDC) מהחשבון
// chat@system.gserviceaccount.com עם audience = כתובת האנדפוינט.
// בודקים את החתימה מול המפתחות הציבוריים של גוגל (JWKS).

let jwksCache = null;
let jwksCacheAt = 0;

async function getJwks() {
  if (jwksCache && Date.now() - jwksCacheAt < 3600 * 1000) return jwksCache;
  const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com");
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  jwksCache = await res.json();
  jwksCacheAt = Date.now();
  return jwksCache;
}

function b64url(buf) {
  return Buffer.from(String(buf).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyChatIdToken(token, audience) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64url(h).toString("utf8"));
    payload = JSON.parse(b64url(p).toString("utf8"));
  } catch {
    return false;
  }
  if (payload.email !== "chat@system.gserviceaccount.com") {
    console.log(`[bot] אימות: email לא צפוי — got=${payload.email}`);
    return false;
  }
  // audience מגיע מגוגל עם סלאש סוגר ב-URL של האנדפוינט — משווים בשתי הצורות
  const audMatch = !payload.aud || !audience || payload.aud === audience || payload.aud === audience + "/";
  if (!audMatch) {
    console.log(`[bot] אימות: audience לא תואם — aud=${payload.aud} ours=${audience}`);
    return false;
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) return false;
  const jwks = await getJwks();
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) return false;
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(h + "." + p);
  const pub = crypto.createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
  const ok = verifier.verify(pub, b64url(s));
  if (!ok) console.log(`[bot] אימות: חתימה נכשלה (kid=${header.kid} iss=${payload.iss})`);
  return ok;
}

async function isAuthorizedRequest(auth, hostHeader) {
  const token = String(auth || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  // 1. טוקן סטטי (לבדיקות מקומיות / legacy)
  if (VERIFY_TOKEN && auth === `Bearer ${VERIFY_TOKEN}`) return true;
  // 2. ID token חתום של Google Chat
  const audience = CHAT_APP_URL || (hostHeader ? `https://${hostHeader}` : "");
  try {
    return await verifyChatIdToken(token, audience);
  } catch (e) {
    console.log(`[bot] אימות ID token נכשל: ${e.message}`);
    return false;
  }
}

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

// ---------- פקודות ----------

const COMMAND_HELP = [
  "🎵 *הפקודות שלי:*",
  "`שיר <קישור>` — שיר באיכות מלאה (MP3)",
  "`שיר נמוך <קישור>` — שיר קל (3GP, קטן — לטלפון/וואטסאפ)",
  "`סרטון <קישור>` — וידאו באיכות מירבית",
  "`סרטון 720/480 <קישור>` — וידאו באיכות נבחרת",
  "`עזרה` — רשימת הפקודות",
  "`טלגרם <חיפוש>` — (בקרוב)",
  "",
  "או פשוט תשלח קישור יוטיוב — אוריד כאודיו כברירת מחדל 🎧",
].join("\n");

/**
 * מפרק את הטקסט אחרי התיוג לפקודה:
 *   "שיר [איכותי|נמוך] <קישור>" | "סרטון [1080|720|480] <קישור>" |
 *   "עזרה" | "טלגרם ..." (בהמשך) | קישור בלבד
 * מחזיר { kind: "download"|"help"|"telegram", format, quality, rest, label }
 *
 * איכויות SaveBridge (מהתוסף): audio/audio_best (MP3) · low_phone/480 (3GP) ·
 * video/best|1080|720|480 (MP4).
 */
function parseCommand(text) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (/^(עזרה|פקודות|עזרה|help|\?|\/help)(\s|$)/.test(lower)) return { kind: "help" };

  // הערה: לא להשתמש ב-\b אחרי עברית (\w ASCII בלבד) — לכן (?:[\s:]|$)
  const tg = lower.match(/^(טלגרם|טלגראם|טלגרמה|telegram|tg)(?:[\s:]|$)([\s\S]*)$/);
  if (tg) return { kind: "telegram", query: tg[2].trim() };

  // שיר / מוזיקה / אודיו — עם איכות אופציונלית
  const audioMatch = lower.match(/^(שיר|מוזיקה|אודיו|סאונד|ש)(?:\s+(איכותי|איכות|נמוך|קל|לייט|low|3gp))?(?:[\s:]|$)([\s\S]*)$/);
  if (audioMatch) {
    const q = audioMatch[2] || "";
    if (/נמוך|קל|לייט|low|3gp/.test(q)) {
      return { kind: "download", format: "low_phone", quality: "480", rest: audioMatch[3].trim(), label: "שיר קל (3GP)" };
    }
    return { kind: "download", format: "audio", quality: "audio_best", rest: audioMatch[3].trim(), label: "השיר" };
  }

  // סרטון / וידאו — עם איכות אופציונלית
  const videoMatch = lower.match(/^(וידאו|וידיאו|סרטון|סרט|mp4|v)(?:\s+(איכותי|איכות|1080|720|480|נמוך|קל|low|best|hd|full))?(?:[\s:]|$)([\s\S]*)$/);
  if (videoMatch) {
    const q = videoMatch[2] || "";
    const qmap = { "1080": "1080", "720": "720", "480": "480", נמוך: "480", קל: "480", low: "480", איכותי: "best", איכות: "best", hd: "best", full: "best", best: "best" };
    return { kind: "download", format: "video", quality: qmap[q] || "best", rest: videoMatch[3].trim(), label: "הסרטון" };
  }

  // ברירת מחדל: קישור בלבד → אודיו
  return { kind: "download", format: "audio", quality: "audio_best", rest: t, label: "השיר" };
}

// ---------- התהליך (רקע) ----------

async function runDownloadAndDeliver({ url, requesterEmail, format = "audio", quality = "audio_best", threadLabel }) {
  try {
    const saveRes = await fetch(`${STORAGE_URL}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, format, quality }),
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

  // 1. אימות — Google שולח ID token חתום (או טוקן סטטי legacy)
  const auth = req.headers.authorization || "";
  if (!(await isAuthorizedRequest(auth, req.headers.host))) {
    console.log(`[bot] ❌ אימות נכשל (Authorization: ${auth.slice(0, 40)}...)`);
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

  // 3. פענוח הפקודה
  const cmd = parseCommand(text);
  if (cmd.kind === "help") {
    return replySync(res, COMMAND_HELP);
  }
  if (cmd.kind === "telegram") {
    return replySync(
      res,
      "🔜 *טלגרם* — עדיין לא מחובר. בקרוב תוכל לבקש חיפוש והעברה מטלגרם.\nבינתיים נסה `שיר <קישור>` או `סרטון <קישור>`."
    );
  }

  // 4. קישור יוטיוב
  const urlMatch = youtubeUrl(cmd.rest);
  if (!urlMatch) {
    return replySync(
      res,
      "לא מצאתי קישור יוטיוב 🔎\n" +
        "`שיר https://youtu.be/xxxx` — אודיו\n" +
        "`סרטון https://youtu.be/xxxx` — וידאו\n" +
        "או תכתוב `עזרה` לכל הפקודות."
    );
  }
  const label = cmd.label || (cmd.format === "video" ? "הסרטון" : "השיר");

  // 5. אישור מיידי + 6. תהליך ברקע
  replySync(res, `מתחיל להוריד את ${label}... 🎧 אחזור עם התוצאה`);
  setTimeout(() => {
    runDownloadAndDeliver({ url: urlMatch, requesterEmail, format: cmd.format, quality: cmd.quality }).catch((e) =>
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

// עזר לבדיקות — הזרקת JWKS ללא רשת
function __setJwksForTest(jwks) {
  jwksCache = jwks;
  jwksCacheAt = Date.now();
}

module.exports = { handle, PORT, isAuthorizedRequest, verifyChatIdToken, __setJwksForTest };
