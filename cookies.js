"use strict";
/**
 * ייצוא עוגיות YouTube/Google בפורמט Netscape — בדיוק כמו שהתוסף
 * SaveBridge עושה לפני כל הורדה. בלי העוגיות, שרת ההורדות מסרב:
 * "יוטיוב דורש חשבון מחובר".
 *
 * שלושה מצבים (לפי סדר העדיפות):
 *   1. SB_COOKIES_FILE      — קובץ עוגיות מקומי (גם היעד שאליו כותב
 *                             שרת האחסון כשה-agent דוחף עוגיות).
 *   2. SB_COOKIES_URL       — שליפת עוגיות מקצה מרוחק (אופציה חלופית
 *                             ל-VPS) עם SB_SYNC_TOKEN ב-header.
 *   3. BrowserCtl מקומי     — ייצוא מהכרום שלך דרך ה-relay (מחשב אישי).
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const BCTL = path.join(__dirname, "..", "tools", "bctl.js");
const COOKIE_DOMAINS = ["youtube.com", "google.com"];

let inFlight = null;
let cached = null;
let lastFetch = 0;
const CACHE_TTL_MS = 2 * 60 * 1000;

function runBctl(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BCTL, ...args], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 300) });
      try {
        resolve({ ok: true, data: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, error: `תשובה לא תקינה מ-BrowserCtl: ${stdout.slice(0, 200)}` });
      }
    });
  });
}

function netscapeLine(c) {
  const hostOnly = Boolean(c.hostOnly);
  let domain = c.domain;
  if (!hostOnly && !domain.startsWith(".")) domain = `.${domain}`;
  const includeSub = hostOnly ? "FALSE" : "TRUE";
  const secure = c.secure ? "TRUE" : "FALSE";
  const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
  const prefix = c.httpOnly ? "#HttpOnly_" : "";
  return `${prefix}${domain}\t${includeSub}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`;
}

async function fromBrowserCtl() {
  const seen = new Set();
  const lines = ["# Netscape HTTP Cookie File"];
  for (const domain of COOKIE_DOMAINS) {
    const res = await runBctl(["cookies.list", JSON.stringify({ domain })]);
    if (!res.ok) {
      return { ok: false, error: `BrowserCtl לא זמין: ${res.error}. הרצת: node tools/control-server.js` };
    }
    const cookies = Array.isArray(res.data?.cookies) ? res.data.cookies : Array.isArray(res.data) ? res.data : [];
    for (const c of cookies) {
      if (!c?.domain || !c?.name) continue;
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(netscapeLine(c));
    }
  }
  if (lines.length === 1) {
    return { ok: false, error: "לא נמצאו עוגיות YouTube/Google בכרום — ודא שאתה מחובר ליוטיוב בדפדפן" };
  }
  return { ok: true, cookies: `${lines.join("\n")}\n` };
}

async function fromUrl() {
  const url = process.env.SB_COOKIES_URL;
  const token = process.env.SB_SYNC_TOKEN || "";
  try {
    const res = await fetch(url, {
      headers: token ? { "x-sync-token": token } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `SB_COOKIES_URL החזיר HTTP ${res.status}` };
    const text = await res.text();
    if (!text || text.length < 50) return { ok: false, error: "SB_COOKIES_URL החזיר תוכן ריק" };
    return { ok: true, cookies: text };
  } catch (e) {
    return { ok: false, error: `SB_COOKIES_URL לא זמין: ${e.message}` };
  }
}

async function fromFile() {
  try {
    const text = fs.readFileSync(process.env.SB_COOKIES_FILE, "utf8");
    if (!text || text.length < 50) return { ok: false, error: "קובץ העוגיות ריק" };
    return { ok: true, cookies: text };
  } catch (e) {
    return { ok: false, error: `לא ניתן לקרוא את SB_COOKIES_FILE: ${e.message}` };
  }
}

/** איסוף העוגיות — מחזיר { ok, cookies | error }. */
async function exportCookies() {
  if (inFlight) return inFlight;
  if (cached && Date.now() - lastFetch < CACHE_TTL_MS) return { ok: true, cookies: cached };

  inFlight = (async () => {
    let res = null;
    if (process.env.SB_COOKIES_FILE) res = await fromFile();
    if (!res?.ok && process.env.SB_COOKIES_URL) res = await fromUrl();
    if (!res?.ok) res = await fromBrowserCtl();
    if (res?.ok) {
      cached = res.cookies;
      lastFetch = Date.now();
    }
    return res;
  })().finally(() => (inFlight = null));

  return inFlight;
}

module.exports = { exportCookies, fromBrowserCtl };
