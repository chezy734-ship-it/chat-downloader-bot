"use strict";
const oauth = require("./oauth");

const mode = process.argv[2] || "auth";

(async () => {
  if (mode === "auth") {
    await oauth.startAuth();
    console.log("ממתין לאישור...");
    await oauth.waitForApproval();
  } else if (mode === "token") {
    console.log(await oauth.getAccessToken());
  } else {
    console.error('שימוש: node oauth-cli.js [auth|token]');
    process.exit(1);
  }
})().catch((e) => {
  console.error("❌ " + e.message);
  process.exit(1);
});
