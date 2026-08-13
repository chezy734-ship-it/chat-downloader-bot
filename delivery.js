"use strict";
/**
 * משלוח הקובץ — Google Drive (לינק) או Gmail (קובץ במייל, עד 25MB).
 * משתמש במודול oauth.js (טוקנים של החשבון שלך, Device Flow).
 */

const fs = require("fs");
const path = require("path");

/**
 * העלאת קובץ לדרייב + שיתוף "כל מי שיש לו את הלינק".
 * @param {{filePath:string, fileName?:string}} input
 * @param {import("./oauth")} oauth
 * @returns {Promise<{ok:true, link:string, fileId:string}>}
 */
async function deliverToDrive(oauth, { filePath, fileName }) {
  const token = await oauth.getAccessToken();
  const name = fileName || path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const meta = { name, mimeType: mimeOf(name) };

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=sbboundary`,
      },
      body: multipartBody(meta, data),
    }
  );
  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error(`העלאה לדרייב נכשלה (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }

  // שיתוף — כל מי שיש לו את הלינק יכול לקרוא
  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${json.id}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!perm.ok) {
    throw new Error(`שיתוף הקובץ נכשל (HTTP ${perm.status}) — אבל הקובץ עלה`);
  }

  return { ok: true, link: json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`, fileId: json.id };
}

/**
 * שליחת קובץ במייל דרך Gmail API.
 * @param {{filePath:string, fileName?:string, to:string}} input
 * @param {import("./oauth")} oauth
 */
async function deliverViaGmail(oauth, { filePath, fileName, to }) {
  const token = await oauth.getAccessToken();
  const name = fileName || path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const sizeMb = data.length / 1024 / 1024;
  if (sizeMb > 24) throw new Error(`הקובץ ${sizeMb.toFixed(1)}MB — גדול מדי למייל (מקסימום 25MB). נסה משלוח לדרייב.`);

  const mime = mimeOf(name);
  const boundary = `sb_${Date.now().toString(36)}`;
  const b64 = data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const raw =
    `To: ${to}\r\n` +
    `Subject: ההורדה שלך: ${name}\r\n` +
    "MIME-Version: 1.0\r\n" +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
    "היי, הנה הקובץ שביקשת.\r\n\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}; name="${name}"\r\n` +
    "Content-Transfer-Encoding: base64\r\n" +
    `Content-Disposition: attachment; filename="${name}"\r\n\r\n` +
    b64 + "\r\n" +
    `--${boundary}--`;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error(`שליחת מייל נכשלה (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { ok: true, messageId: json.id, to };
}

// ---------- עזרים ----------

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".3gp": "video/3gpp",
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".png": "image/png",
  };
  return map[ext] || "application/octet-stream";
}

function multipartBody(meta, data) {
  const parts = [
    `--sbboundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--sbboundary\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
  ];
  return Buffer.concat([Buffer.from(parts[0], "utf8"), Buffer.from(parts[1], "utf8"), data, Buffer.from("\r\n--sbboundary--\r\n", "utf8")]);
}

module.exports = { deliverToDrive, deliverViaGmail };
