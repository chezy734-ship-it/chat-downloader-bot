"use strict";
/**
 * סוכן עוגיות — רץ על המחשב האישי בלבד.
 *
 * כל X דקות: מייצא את עוגיות היוטיוב מהכרום שלך (דרך BrowserCtl)
 * ודוחף אותן לשרת (ה-VPS) ל-`POST /api/cookies` עם טוקן משותף.
 * כך השרת עצמו לא יושב על המחשב שלך — רק הזהות שלך עוברת אליו.
 *
 * הפעלה:
 *   SB_SERVER_URL=https://bot.example.com SB_SYNC_TOKEN=<secret> \
 *     node cookie-agent.js
 *
 * אופציות:
 *   SB_INTERVAL_MS   מחזור דחיפה (ברירת מחדל 20 דקות)
 *   --once           דחיפה אחת ויציאה (לבדיקות)
 *   --debug          הדפסת פרטים
 *
 * דרישות במחשב: ה-relay של BrowserCtl רץ (node tools/control-server.js)
 * והתוסף מחובר, עם סשן מחובר ליוטיוב בכרום.
 */

const { exportCookies, fromBrowserCtl } = require("./cookies");

const SERVER_URL = process.env.SB_SERVER_URL || "";
const SYNC_TOKEN = process.env.SB_SYNC_TOKEN || "";
const INTERVAL_MS = Number(process.env.SB_INTERVAL_MS || 20 * 60 * 1000);
const DEBUG = process.argv.includes("--debug");
const ONCE = process.argv.includes("--once");

function log(...args) {
  console.log(`[cookie-agent ${new Date().toLocaleTimeString()}]`, ...args);
}

async function pushOnce() {
  const res = await fromBrowserCtl();
  if (!res.ok) {
    log("❌ ייצוא עוגיות נכשל:", res.error);
    return false;
  }
  if (!SERVER_URL) {
    log("❌ חסר SB_SERVER_URL");
    return false;
  }
  if (!SYNC_TOKEN) {
    log("❌ חסר SB_SYNC_TOKEN");
    return false;
  }
  try {
    const push = await fetch(`${SERVER_URL.replace(/\/+$/, "")}/api/cookies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-token": SYNC_TOKEN,
      },
      body: JSON.stringify({ cookies: res.cookies }),
      signal: AbortSignal.timeout(20000),
    });
    if (!push.ok) {
      log(`❌ השרת דחה את הדחיפה (HTTP ${push.status})`);
      if (DEBUG) log(await push.text().catch(() => ""));
      return false;
    }
    const json = await push.json().catch(() => null);
    if (DEBUG) log("דחיפה הצליחה:", JSON.stringify(json));
    else log(`✅ דחיפה הצליחה (${res.cookies.length} תווים)`);
    return true;
  } catch (e) {
    log("❌ שגיאת רשת:", e.message);
    return false;
  }
}

async function main() {
  if (!SERVER_URL) log("⚠️ SB_SERVER_URL לא מוגדר — לא נדחוף לשום מקום");
  if (!SYNC_TOKEN) log("⚠️ SB_SYNC_TOKEN לא מוגדר — השרת ידחה את הדחיפה");

  if (ONCE) {
    process.exit((await pushOnce()) ? 0 : 1);
  }

  // דחיפה ראשונה מיד, ואז בלולאה
  await pushOnce();
  setInterval(pushOnce, INTERVAL_MS);
  log(`רץ ברקע — דוחף כל ${Math.round(INTERVAL_MS / 60000)} דקות. עצירה: Ctrl+C`);
}

main();
