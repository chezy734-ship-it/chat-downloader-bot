"use strict";
/**
 * Entry point ל-Render — מפעיל את שרת האחסון ואת בוט הצ'אט על אותו פורט.
 *
 * Render נותן ל-web service אחד פורט אחד בלבד (משתנה PORT), אז אנחנו
 * משלבים כאן את שני ה-handlers:
 *   GET  /          -> 200 ok (בריאות השרת עבור Render)
 *   POST /          -> בוט Google Chat (webhook)
 *   GET  /health    -> סטטוס שרת האחסון + SaveBridge
 *   /api/*          -> שרת האחסון (download/jobs/save/cookies/files)
 *
 * הפעלה מקומית לבדיקה:
 *   PORT=9796 node render-server.js
 * ואז:
 *   curl http://127.0.0.1:9796/health
 *   curl -X POST http://127.0.0.1:9796/ -H "Authorization: Bearer test" ...
 */

const PORT = Number(process.env.PORT || 9796);
// שני השרתים יפעלו על אותו פורט — הבוט יפנה לאחסון ב-loopback
if (!process.env.SB_HOST) process.env.SB_HOST = "0.0.0.0";
if (!process.env.STORAGE_URL) process.env.STORAGE_URL = `http://127.0.0.1:${PORT}`;

const http = require("http");
const { handle: botHandle } = require("./chat-bot");
const { handle: storageHandle } = require("./storage-server");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "chat-downloader-bot", port: PORT }));
    return;
  }
  if (p.startsWith("/api") || p === "/health") {
    return storageHandle(req, res);
  }
  return botHandle(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[render] מאזין על :${PORT}`);
  console.log(`[render] STORAGE_URL=${process.env.STORAGE_URL}`);
});
