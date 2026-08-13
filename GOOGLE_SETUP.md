# הגדרת Google Cloud — Chat app + OAuth (Drive/Gmail)

דף הצ'קליסט המלא. מתבצע ב-`console.cloud.google.com` (החשבון: g05832169@gmail.com).
**תנאי מוקדם: 2-Step Verification מופעל** — בלעדיו גוגל חוסמת את ה-Console.

## שלב 0 — אימות דו-שלבי (פעם אחת, רק אתה)

1. `myaccount.google.com/security` → **אימות דו-שלבי** → הפעל (עם הטלפון).
2. המתן כמה דקות, רענן את `console.cloud.google.com`.

## שלב 1 — פרויקט

1. `console.cloud.google.com` → בחירת פרויקט (למעלה) → **New Project**.
2. שם: `chat-downloader-bot` → Create.
3. ודאו שהפרויקט נבחר (תפריט הפרויקט למעלה).

## שלב 2 — הפעלת Google Chat API

1. `APIs & Services → Library` (או ישירות:
   `console.cloud.google.com/apis/library/chat.googleapis.com`).
2. חפשו **Google Chat API** → Enable.

## שלב 3 — יצירת מרחב בדיקות חדש (לא נוגעים בקבוצות קיימות!)

> **החלטה:** בשלב הראשוני הבוט חי במרחב **חדש וייעודי** בלבד.
> שום קבוצה קיימת (כמו "בוגרי טכנוב") לא מעורבת — לא בהתקנה, לא בבדיקות.

1. בגוגל צ'אט: **Create space** → שם: `בוגרי מכנובקא` (השם עודכן מ`בוט בדיקות 🎵`).
2. אפשר להשאיר את המרחב עם **רק אותך** בהתחלה — הבוט מתווסף אליו
   והבדיקות נעשות שם בלי להפריע לאף אחד.
3. בהמשך, כשהכל עובד — רק אז להחליט אם (ובאיזה קבוצה) להרחיב.

> ✅ **בוצע:** המרחב `בוגרי מכנובקא` כבר נוצר ושמו עודכן (מזהה: `AAQA8lSV7_U`).
> בשלב ההתקנה של ה-Chat app (שלב 4, `Specific spaces`) יש להשתמש
> במזהה הזה — ורק בו.

## שלב 4 — הגדרת ה-Chat app

1. **Google Chat API → Configuration** (תפריט צד).
2. מילוי השדות:
   | שדה | ערך |
   |---|---|
   | App name | `Download Bot` (או מה שתרצה) |
   | Avatar | קובץ תמונה (אופציונלי) |
   | Description | "מוריד מיוטיוב ושולח לדרייב/מייל" |
   | **Connection settings** | `Apps script project` **לא** — בוחרים **`HTTPS endpoint`** |
   | **HTTPS endpoint URL** | `https://chat-downloader-bot.onrender.com/` — השרת כבר חי על Render (חינם) |
   | **Verification token** | נוצר על ידי גוגל — **להעתיק ל-CHAT_VERIFICATION_TOKEN** |
   | App status | `LIVE – available to users` |
3. **Save.**
4. **Permissions**: Chat API → Configuration → **Manage deployment** →
   **`Specific spaces`** → הוסיפו **רק את מרחב הבדיקות** החדש
   (ולא שום קבוצה אחרת בשלב הזה).

## שלב 5 — OAuth Client (ל-Drive + Gmail + צ'אט)

1. `APIs & Services → OAuth consent screen`:
   - User type: **External** → Create.
   - App name, user support email → Save.
   - (לא צריך Scopes כאן — הגדרה נעשית בקוד.)
   - **Audience → Publish app** (או להוסיף את המייל שלך כ-**Test user** אם נשארים ב-Testing).
2. `APIs & Services → Credentials → Create Credentials → OAuth client ID`:
   - Application type: **Desktop app** (עובד מצוין עם Device Flow).
   - שם: `sb-bot` → Create.
   - העתיקו **Client ID + Client Secret** ל-`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. `APIs & Services → Library` → הפעילו גם:
   - **Google Drive API**
   - **Gmail API**

## שלב 6 — Incoming Webhook (לתשובות הסופיות)

מכיוון שהחשבון אישי (בלי Service Account), אין דרך רשמית לענות
אסינכרונית "בשם הבוט" ב-REST. הפתרון:

1. במרחב הצ'אט: **Settings → Apps & integrations → Add apps → Webhooks**.
2. שם: `MusicBot` → קבלו את ה-URL → `INCOMING_WEBHOOK_URL`.
3. הבוט שולח אליו את התוצאה הסופית (מופיע בשם "MusicBot").

## שלב 7 — אישור OAuth (פעם אחת)

```bash
node -e "require('./oauth').startAuth().then(()=>console.log('הרץ: node -e \"require(\"./oauth\").waitForApproval()\"'))"
# או פשוט:
node tools/oauth-cli.js        # (ראה מטה)
```

1. `node tools/oauth-cli.js` → מדפיס URL + קוד.
2. פתחו, הזינו את הקוד, אישרו עם החשבון.
3. הטוקנים נשמרים ב-`data/google-token.json` (chmod 600) — רענון אוטומטי.

## שלב 8 — בדיקות

1. הוסיפו את ה-Chat app למרחב: **Settings → Apps and integrations → Add apps** →
   תבחרו את האפליקציה לפי השם.
2. תיוג עם פקודות:
   - `@DownloadBot עזרה` → רשימת הפקודות
   - `@DownloadBot שיר https://youtu.be/...` → הורדה כאודיו (MP3)
   - `@DownloadBot שיר נמוך https://youtu.be/...` → שיר קל (3GP)
   - `@DownloadBot סרטון https://youtu.be/...` → הורדה כווידאו (best)
   - `@DownloadBot סרטון 720 https://youtu.be/...` → וידאו באיכות נבחרת
   - `@DownloadBot https://youtu.be/...` → אודיו כברירת מחדל
   - `@DownloadBot טלגרם ...` → (בקרוב)
3. הבוט עונה "מתחיל להוריד..." ואז שולח את הלינק לדרייב.
4. בודקים את הלוגים: `journalctl -u sb-bot -f` (אחרי הוספת ה-unit).

---

### קובץ oauth-cli.js (להוסיף כשיש צורך)

```js
const oauth = require("./oauth");
const mode = process.argv[2] || "auth";
(async () => {
  if (mode === "auth") {
    await oauth.startAuth();
    console.log("ממתין לאישור...");
    await oauth.waitForApproval();
  } else if (mode === "token") {
    console.log(await oauth.getAccessToken());
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```
