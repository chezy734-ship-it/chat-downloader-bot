"use strict";
/**
 * vps-cookie-keeper — שומר סשן יוטיוב על ה-VPS (ללא תלות במחשב האישי).
 *
 * מריץ Chrome/Chromium על השרת (פרופיל ייעודי — דרישה של Chrome>=136 ל-CDP),
 * שומר על הסשן חי ומייצא את העוגיות לפורמט Netscape ל-`data/cookies.txt`
 * שאליו קורא storage-server.js — אז ההורדות עובדות בלי מחשב אישי.
 *
 * מצבים:
 *   node vps-cookie-keeper.js --login   ← כניסה ראשונה (משאיר את Chrome פתוח)
 *   node vps-cookie-keeper.js --once    ← בדיקה חד-פעמית של ייצוא
 *   node vps-cookie-keeper.js           ← לולאת שמירה (ברירת מחדל)
 *
 * Env:
 *   SB_CHROME_BIN      נתיב ל-chromium/google-chrome (אוטומטי אם לא מוגדר)
 *   SB_KEEPER_INTERVAL מחזור שמירה במילישניות (ברירת מחדל 15 דקות)
 *   SB_COOKIES_STORE   נתיב קובץ העוגיות (ברירת מחדל data/cookies.txt)
 *   SB_CDP_PORT        פורט ה-debug (ברירת מחדל 9222)
 *   SB_PROFILE_DIR     פרופיל Chrome (ברירת מחדל /opt/sb/browser)
 *   SB_XVFB=1          הרצה תחת xvfb-run (שרת ללא מסך)
 *   SB_HEADLESS=1      הרצה ב-headless במקום xvfb (מהיר יותר, סיכוי גבוה יותר לחסימה)
 *
 * הערה: נכתב ללא בדיקה מול VPS אמיתי — מריצים אחרי ההתקנה לפי VPS_SETUP.md.
 * דורש Node.js >= 22 (WebSocket מובנה).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const CDP_PORT = Number(process.env.SB_CDP_PORT || 9222);
const PROFILE_DIR = process.env.SB_PROFILE_DIR || "/opt/sb/browser";
const STORE = process.env.SB_COOKIES_STORE || path.join(__dirname, "data", "cookies.txt");
const INTERVAL_MS = Number(process.env.SB_KEEPER_INTERVAL || 15 * 60 * 1000);
const MODE_LOGIN = process.argv.includes("--login");
const MODE_ONCE = process.argv.includes("--once");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// ---------- Chrome ----------

function pickChromeBin() {
  if (process.env.SB_CHROME_BIN) return process.env.SB_CHROME_BIN;
  for (const b of ["chromium-browser", "google-chrome", "chromium"]) {
    try {
      require("child_process").execSync(`which ${b}`, { stdio: "ignore" });
      return b;
    } catch {}
  }
  return "chromium";
}

function chromeArgs() {
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--noerrdialogs",
    "--disable-dev-shm-usage",
    "--window-size=1280,900",
  ];
  // root ללא sandbox — אחרת Chrome מסרב לעלות על שרת
  if (IS_ROOT) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

function launchChrome() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const bin = pickChromeBin();
  const args = chromeArgs();
  let child;
  if (process.env.SB_XVFB === "1") {
    child = spawn("xvfb-run", ["-a", bin, ...args], { stdio: "ignore" });
    console.log(`[keeper] מפעיל: xvfb-run ${bin} (פרופיל ${PROFILE_DIR})`);
  } else if (process.env.SB_HEADLESS === "1") {
    child = spawn(bin, ["--headless=new", ...args], { stdio: "ignore" });
    console.log(`[keeper] מפעיל: ${bin} --headless=new (פרופיל ${PROFILE_DIR})`);
  } else {
    child = spawn(bin, args, { stdio: "ignore" });
    console.log(`[keeper] מפעיל: ${bin} (פרופיל ${PROFILE_DIR}) — דורש DISPLAY או SB_XVFB=1`);
  }
  child.on("exit", (code) => console.log(`[keeper] Chrome נסגר (קוד ${code})`));
  return child;
}

// ---------- CDP ----------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            reject(new Error(`תשובה לא תקינה מ-CDP: ${d.slice(0, 100)}`));
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForCdp(timeoutMs = 25000) {
  const started = Date.now();
  for (;;) {
    try {
      return await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error("Chrome לא עלה — בדוק לוגים");
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("חיבור WebSocket נכשל"));
  });
  async function call(method, params = {}) {
    await ready;
    const thisId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }
  return { call, close: () => ws.close() };
}

async function openTab(url) {
  const tab = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`);
  const page = cdpSession(tab.webSocketDebuggerUrl);
  await page.call("Page.enable");
  await page.call("Network.enable");
  await page.call("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 4000));
  return page;
}

async function screenshot(page, file) {
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// ---------- עוגיות ----------

function toNetscape(c) {
  // CDP: {name, value, domain, path, secure, httpOnly, expires (שניות)}
  let domain = c.domain;
  const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
  if (!domain.startsWith(".")) domain = `.${domain}`;
  const secure = c.secure ? "TRUE" : "FALSE";
  const expiry = c.expires ? Math.floor(c.expires) : 0;
  const prefix = c.httpOnly ? "#HttpOnly_" : "";
  return `${prefix}${domain}\t${includeSub}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`;
}

async function getAllCookies(page) {
  const { cookies } = await page.call("Network.getAllCookies");
  return cookies;
}

async function exportToStore(page) {
  const cookies = await getAllCookies(page);
  const wanted = cookies.filter((c) => c.domain.includes("youtube.com") || c.domain.includes("google.com"));
  const seen = new Set();
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of wanted) {
    const key = `${c.domain}|${c.name}|${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(toNetscape(c));
  }
  const text = `${lines.join("\n")}\n`;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, text, { mode: 0o600 });
  console.log(`[keeper] ✅ ייצאתי ${wanted.length} עוגיות -> ${STORE}`);
  return text;
}

function hasSessionCookie(cookies) {
  return cookies.some((c) => c.name === "SID" || c.name === "__Secure-1PSID");
}

// ---------- מצבים ----------

async function ensureChromeRunning() {
  try {
    await waitForCdp(3000);
    return null; // כבר רץ
  } catch {
    return launchChrome();
  }
}

async function runOnce({ leaveChrome }) {
  const chrome = await ensureChromeRunning();
  const tab = await openTab("https://www.youtube.com");
  const loggedIn = hasSessionCookie(await getAllCookies(tab));
  if (!loggedIn) {
    const file = await screenshot(tab, path.join(__dirname, "login-page.png"));
    console.log("[keeper] ❌ לא מחובר ליוטיוב.");
    console.log(`[keeper] צילום מסך: ${file}`);
    console.log("[keeper] כניסה — במחשב שלך:");
    console.log(`[keeper]   1) ssh -L ${CDP_PORT}:127.0.0.1:${CDP_PORT} <user>@<vps-ip>`);
    console.log(`[keeper]   2) פתח בכרום מקומי: http://127.0.0.1:${CDP_PORT} → טאב YouTube → התחבר`);
    console.log("[keeper]   3) (או) אם מופיע QR בצילום — סרוק עם הטלפון");
    console.log("[keeper] אחרי ההתחברות הרץ שוב: node vps-cookie-keeper.js --once");
    tab.close();
    if (!leaveChrome && chrome) chrome.kill();
    return false;
  }
  await exportToStore(tab);
  tab.close();
  if (!leaveChrome && chrome) chrome.kill();
  return true;
}

async function mainLoop() {
  console.log(`[keeper] לולאת שמירה — כל ${Math.round(INTERVAL_MS / 60000)} דקות. Ctrl+C לעצירה`);
  let chrome = null;
  let ticks = 0;
  for (;;) {
    try {
      chrome = await ensureChromeRunning();
      const tab = await openTab("https://www.youtube.com");
      const loggedIn = hasSessionCookie(await getAllCookies(tab));

      if (loggedIn) {
        if (ticks % 6 === 0) {
          // רענון תקופתי של הסשן — ביקור ביוטיוב
          await tab.call("Page.navigate", { url: "https://www.youtube.com" });
          await new Promise((r) => setTimeout(r, 3000));
        }
        await exportToStore(tab);
      } else {
        // לא מחובר — לא מנווטים ולא מפריעים לכניסה; רק מתעדים ומצלמים
        const file = await screenshot(tab, path.join(__dirname, "login-page.png"));
        console.log(`[keeper] ⚠️ הסשן פג — נדרשת כניסה דרך ה-tunnel. צילום: ${file}`);
      }
      tab.close();
      ticks++;
    } catch (e) {
      console.log(`[keeper] שגיאה במחזור: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

async function main() {
  if (MODE_LOGIN) {
    await runOnce({ leaveChrome: true }); // נשאיר את Chrome פתוח לכניסה דרך ה-tunnel
    process.exit(0);
  }
  if (MODE_ONCE) {
    process.exit((await runOnce({ leaveChrome: false })) ? 0 : 1);
  }
  await mainLoop();
}

main();
