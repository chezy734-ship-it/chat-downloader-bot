# Chat Downloader Bot 🤖🎵

בוט ל-**Google Chat** שכשמתייגים אותו בקבוצה מגיב, יוריד מיוטיוב שיר/סרטון,
ישמור אותו זמנית וישלח אותו למבקש — **ל-Drive (לינק) או במייל**.

## איך זה עובד

```
Google Chat (@mention + URL)
      │
      ▼
[שרת: VPS / Render] בוט + אחסון זמני (render-server.js)
      │
      ├──► שרת SaveBridge (extsync.com/sb-relay) ── yt-dlp + ffmpeg ──┐
      │                                                                ▼
      │                                                       קובץ נוחת ב-storage/ (נמחק אחרי שעה)
      ▼                                                                │
משלוח: Google Drive (לינק) | Gmail (קובץ במייל, עד 25MB) ◄──────────────┘

[המחשב האישי] cookie-agent.js ──דוחף עוגיות יוטיוב כל ~10-20 דק'──► POST /api/cookies (השרת)
```

שתי החלטות עיצוב חשובות:

1. **התוסף SaveBridge לא חייב להיות פתוח בדפדפן.** התוסף רק שולח
   פקודות לשרת ההורדות — ואנחנו מדברים עם אותו שרת בדיוק, באותו
   פרוטוקול (חתימת HMAC + טוקן). הקוד לקוח מ-`extension-1/background.js`.

2. **השרת לא יושב על המחשב האישי.** כל העבודה (בוט, אחסון זמני, הורדה,
   משלוח) רצה על שרת מרוחק — VPS או **Render** (התוכנית החינמית, בלי
   כרטיס אשראי). המחשב שלך משתתף רק בחלק שאי אפשר להעביר: הזהות שלך
   ביוטיוב (עוגיות). הסוכן הזעיר `cookie-agent.js` מייצא אותן מהכרום
   (דרך BrowserCtl) ודוחף לשרת — בלי אחסון מקומי, בלי שרת.

## מה כבר קיים

| רכיב | קובץ | סטטוס |
|---|---|---|
| קליינט SaveBridge | `savebridge-client.js` | ✅ עובד (נבדק חי) |
| שרת אחסון זמני | `storage-server.js` | ✅ עובד — הורדה, שמירה, קבלת עוגיות |
| עוגיות (3 מצבים) | `cookies.js` | ✅ עובד (קובץ / URL / BrowserCtl) |
| סוכן עוגיות (PC) | `cookie-agent.js` | ✅ עובד — דחיפה לשרת עם טוקן |
| שרת משולב ל-Render | `render-server.js` | ✅ עובד — אחסון + בוט על פורט אחד |
| פריסת Render | `render.yaml` + `package.json` | ✅ מוכן להרשמה |
| משלוח ל-Drive | `delivery.js` | ⏳ סטאב — ממתין ל-OAuth |
| משלוח במייל | `delivery.js` | ⏳ סטאב — ממתין ל-OAuth |
| בוט Google Chat | `chat-bot.js` | ✅ webhook נבדק חי |

> ✅ **נבדק חי:** `Me at the zoo.mp3` (0.34MB) ו-`Big Buck Bunny...mp3` (19MB)
> ירדו מיוטיוב דרך השרת ונשמרו ב-`storage/`. הסוכן דחף את העוגיות האמיתיות
> לשרת עם אימות טוקן (403 לטוקן שגוי, 200 לטוקן נכון).

## הפעלה ובדיקה

```bash
# הורדה ובדיקה מלאה (וידאו חינמי — Big Buck Bunny)
node storage-server.js --test "https://www.youtube.com/watch?v=aqz-KE-bpKQ" audio audio_best

# הרצת השרת (על ה-VPS)
SB_SYNC_TOKEN=<סוד משותף> node storage-server.js     # http://0.0.0.0:9796

# במחשב האישי — סוכן העוגיות (דרוש: relay של BrowserCtl + כרום מחובר ליוטיוב)
SB_SERVER_URL=https://<domain>:9796 SB_SYNC_TOKEN=<סוד משותף> node cookie-agent.js

# דוגמת קריאה: מתחיל הורדה ומחזיר jobId
curl -X POST http://127.0.0.1:9796/api/download \
  -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","format":"audio","quality":"audio_best"}'

# דוגמת קריאה: ממתין עד הסוף ושומר את הקובץ
curl -X POST http://127.0.0.1:9796/api/save \
  -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}'
```

> שרת ההורדות דורש HTTPS מול האינטרנט (העוגיות הן זהות). אם השרת
> מאחורי proxy/TLS — עדיף. בפריסה ראשונה אפשר גם על loopback + tunnel.

## פריסה על Render (מומלץ — חינם, בלי כרטיס אשראי)

Render נותן web service חינמי: Node, HTTPS מובנה, בלי כרטיס. השרת
נרדם אחרי ~15 דק' חוסר פעילות ומתעורר על בקשה (התעוררות ראשונה ~30-60
שניות). הבוט שלנו מונע-אירועים (עובד רק כמתייגים), אז זה מתאים.

1. **דחיפה ל-GitHub** — repo פרטי או ציבורי עם התיקייה הזו (כולל
   `render.yaml`, `package.json`, `render-server.js`).
2. **ב-Render**: `New +` → **Blueprint** → בחר את ה-repo.
   (אם ה-repo כולל עוד דברים — הגדר Root Directory = `chat-downloader-bot`.)
3. Render יוצר את ה-service מ-`render.yaml` ומנפק URL:
   `https://chat-downloader-bot.onrender.com`.
4. **מלא את ה-Secrets** בלוח הבקרה (אלה עם `sync: false`):
   `CHAT_VERIFICATION_TOKEN`, `ALLOWED_USERS` (האימיילים שלך, פסיקים),
   `INCOMING_WEBHOOK_URL` (ייווצר בשלב ה-Chat app),
   `SB_SYNC_TOKEN` (סוד משותף עם הסוכן), `STORAGE_TOKEN` (אופציונלי).
5. **בדיקה**: `curl https://<name>.onrender.com/health` → `{ok:true,...}`.
6. **במחשב האישי** — הסוכן דוחף עוגיות וגם שומר על השרת ער:
   ```bash
   SB_SERVER_URL=https://<name>.onrender.com SB_SYNC_TOKEN=<סוד> \
   SB_INTERVAL_MS=600000 node cookie-agent.js
   ```
7. **Google Chat** — ההגדרה של ה-Chat app תפנה ל-
   `https://<name>.onrender.com` (webhook POST).

> ⚠️ הערה: בחשבון החינמי הקובץ `data/cookies.txt` הוא ארעי (נמחק ב-
> redeploy) — לא נורא: הסוכן דוחף עוגיות טריות כל 10 דק'.

## פריסה על ה-VPS (אלטרנטיבה)

```bash
# מעתיקים את התיקייה ל-VPS ומריצים סקריפט אחד:
sudo bash deploy-vps.sh
```

הסקריפט מתקין הכל (Node, Chrome, xvfb, משתמש sb, systemd, ufw, SSH hardening
אופציונלי), ואז: כניסה ליוטיוב דרך tunnel → בדיקת קיפר (`--once`) →
`systemctl start sb-keeper sb-server`. הוראות מלאות + ניתוח סיכונים:
**`VPS_SETUP.md`**.

## השלבים הבאים

1. **פריסה על Render** — Blueprint מ-`render.yaml`, מילוי ה-Secrets,
   והפעלת `cookie-agent` במחשב.
2. **Google Cloud** — יצירת פרויקט, הפעלת Chat API, יצירת Chat app
   (נעשה דרך הדפדפן שלך עם BrowserCtl).
3. **OAuth ל-Drive + Gmail** — אישור גישה לחשבון שלך, ואז מימוש `delivery.js`.
4. **שרת הבוט** — מקבל webhook מ-Google Chat, בודק allowlist
   (רק החברים שבחרת), מנתח את הפקודה ומריץ את התהליך.
5. **חשיפה לאינטרנט** — דומיין + TLS (או cloudflared) כדי שגוגל תגיע לשרת.
6. **טלגרם** — אחרי שיוטיוב עובד (הוסכם).

## אבטחה

- הקובץ עובר דרך שרת ההורדות (extsync.com/sb-relay) — שירות צד שלישי.
  אם זה מדאיג, יש מצב הצפנה בתוסף (`encryptDownloads`) שכדאי לשקול.
- קבצים באחסון הזמני נמחקים אוטומטית אחרי שעה.
- הטוקנים (SaveBridge + Google) נשמרים מקומית, לא בגיט.
- **זכויות יוצרים**: ברירת מחדל מומלצת — שליחת לינק (Drive) במקום קובץ לכולם.
