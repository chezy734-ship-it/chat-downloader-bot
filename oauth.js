"use strict";
/**
 * Google OAuth — Device Flow (מושלם ל-CLI/שרת בלי דפדפן מקומי).
 *
 * 1) google device/code  → מקבלים verification_url + user_code
 * 2) המשתמש נכנס ל-URL ומזין את הקוד (או סורק QR)
 * 3) פולינג ל-token עד שהמשתמש אישר → access + refresh token
 * 4) הטוקנים נשמרים בקובץ (chmod 600) ומתרעננים אוטומטית
 *
 * שימוש:
 *   const oauth = require("./oauth");
 *   await oauth.startAuth();            // מדפיס URL + קוד
 *   const token = await oauth.getAccessToken();  // אחרי האישור
 */

const fs = require("fs");
const path = require("path");

const AUTH_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file", // קבצים שהאפליקציה יוצרת בדרייב
  "https://www.googleapis.com/auth/gmail.send", // שליחת מייל
  "https://www.googleapis.com/auth/chat.messages", // תשובות אסינכרוניות בצ'אט
].join(" ");

function config() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    tokenFile: process.env.GOOGLE_TOKEN_FILE || path.join(__dirname, "data", "google-token.json"),
  };
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(config().tokenFile), { recursive: true });
  fs.writeFileSync(config().tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(config().tokenFile, "utf8"));
  } catch {
    return null;
  }
}

/** התחלת האישור — מדפיסה URL + קוד למשתמש. מחזירה true אם התחיל. */
async function startAuth() {
  const { clientId } = config();
  if (!clientId) throw new Error("חסר GOOGLE_CLIENT_ID — יש ליצור OAuth Client ב-Google Cloud (ראה GOOGLE_SETUP.md)");
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`device/code נכשל: ${JSON.stringify(json)}`);
  // שמירת device_code לעתיד
  saveTokens({ ...loadTokens(), deviceCode: json.device_code, scopes: SCOPES });
  console.log("\n  🔗 פתח בדפדפן: " + json.verification_url);
  console.log("  🔢 והזן קוד: " + json.user_code + "\n");
  return { url: json.verification_url, code: json.user_code, expiresIn: json.expires_in, interval: json.interval };
}

/** פולינג עד אישור. מחזיר true כשהטוקנים נשמרו. */
async function waitForApproval({ intervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const { clientId, clientSecret } = config();
  const tokens = loadTokens();
  if (!tokens?.deviceCode) throw new Error("לא התחיל אישור — הרץ startAuth() קודם");
  const started = Date.now();
  for (;;) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: tokens.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const json = await res.json();
    if (json.access_token) {
      saveTokens({ ...tokens, accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + json.expires_in * 1000 });
      console.log("✅ אושר! הטוקנים נשמרו ב-" + config().tokenFile);
      return true;
    }
    if (json.error === "authorization_pending" || json.error === "slow_down") {
      await new Promise((r) => setTimeout(r, json.error === "slow_down" ? intervalMs * 2 : intervalMs));
      if (Date.now() - started > timeoutMs) throw new Error("תם הזמן לאישור");
      continue;
    }
    throw new Error(`שגיאת אישור: ${json.error}`);
  }
}

/** קבלת access token (מרענן אם פג). */
async function getAccessToken() {
  const { clientId, clientSecret } = config();
  const tokens = loadTokens();
  if (!tokens?.accessToken) throw new Error("עוד לא אושר OAuth — הרץ startAuth() ואז waitForApproval()");
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - 60 * 1000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("אין refresh token ואין access token תקף");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`רענון נכשל: ${JSON.stringify(json)}`);
  saveTokens({ ...tokens, accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

module.exports = { startAuth, waitForApproval, getAccessToken, SCOPES };
