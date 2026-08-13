# פריסה על ה-VPS — מדריך מלא

מטרה: כל המערכת (בוט + אחסון + הורדות + סשן יוטיוב) רצה על ה-VPS,
והמחשב האישי לא משתתף בכלל.

## הדרך המהירה — סקריפט אחד

העתק את תיקיית `chat-downloader-bot/` ל-VPS (למשל ל-`/root/`), ואז:

```bash
cd chat-downloader-bot
sudo bash deploy-vps.sh
```

הסקריפט עושה הכל, ברצף ובאופן אידמפוטנטי (בטוח להרצה חוזרת):

| שלב | מה קורה |
|---|---|
| 0 | בדיקות: רץ כשורש, מריצים מהתיקייה הנכונה |
| 1 | `apt update` + חבילות בסיס (curl, xvfb...) |
| 2 | Node.js 22 (nodesource) |
| 3 | דפדפן: Google Chrome stable (או `CHROME_MODE=snap` ל-Chromium) |
| 4 | משתמש שירות `sb` (ללא לוגין) |
| 5 | העתקת הפרויקט ל-`/opt/sb`, ניקוי storage/data ישנים |
| 6 | `.env` עם `SB_SYNC_TOKEN` אקראי (מוצג בסוף + נשמר chmod 600) |
| 7 | שירותי systemd: `sb-keeper` + `sb-server` (נרשמו, לא הופעלו עדיין) |
| 8 | ufw: דחיית הכל, חריגים SSH + 80 + 443. פורט 9796 חסום מבחוץ |
| 9 | `HARDEN_SSH=1` (אופציונלי) — רק אם קיימים מפתחות, עם `sshd -t` לפני reload |
| 10 | הדפסת השלבים הבאים: כניסה → בדיקת קיפר → הפעלת שירותים |

משתנים שימושיים: `SB_APP_DIR`, `SB_RUN_USER`, `SSH_PORT`, `CHROME_MODE`,
`HARDEN_SSH`, `SB_XVFB`.

## אחרי הפריסה — כניסה ראשונה ליוטיוב

```bash
cd /opt/sb
sudo -u sb node vps-cookie-keeper.js --login
# במחשב שלך, בטרמינל אחר:
ssh -L 9222:127.0.0.1:9222 root@<vps-ip>
# בכרום המקומי: http://127.0.0.1:9222 → טאב YouTube → התחבר עם החשבון
# (הסיסמה נכתבת בדפדפן שלך; הסשן נשמר בפרופיל שעל ה-VPS)
```

חלופה: אם בדף הכניסה מופיע QR — סרוק עם הטלפון.

## בדיקת הקיפר

```bash
sudo -u sb node /opt/sb/vps-cookie-keeper.js --once
# מצופה: "✅ ייצאתי N עוגיות -> /opt/sb/data/cookies.txt"
ls -la /opt/sb/data/cookies.txt        # קובץ קיים, לא ריק
```

אם לא מחובר — הוא יצלם מסך ל-`login-page.png` ויסביר איך להיכנס.
**חשוב:** אל תפעיל את השירות `sb-keeper` לפני שמסיימים את הכניסה —
הלולאה מנוהלת כך שהיא לא מפריעה לכניסה (לא מנווטת כשלא מחוברים),
אבל נקי יותר להיכנס קודם.

## הפעלת השירותים

```bash
systemctl start sb-keeper sb-server
systemctl status sb-keeper sb-server
journalctl -u sb-keeper -n 50 --no-pager     # לוגים
```

## בדיקת שרת האחסון (מקומית על ה-VPS)

```bash
curl -s http://127.0.0.1:9796/api
curl -s -X POST http://127.0.0.1:9796/api/save \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}'
```

הקובץ יופיע ב-`/opt/sb/storage/`. (ההורדה בפועל עוברת דרך שרת SaveBridge
המרוחק — השרת שלך רק מאחסן זמנית ושולח.)

## גיבוי מהמחשב (אופציונלי)

אם תרצה שאף פעם לא תהיה תלוי בסשן שעל השרת — הרץ על המחשב שלך את
`cookie-agent.js` (שכבר נבדק חי) עם אותו `SB_SYNC_TOKEN`:

```bash
SB_SERVER_URL=https://<domain-or-ip>:9796 SB_SYNC_TOKEN=<token> node cookie-agent.js
```

> הערה: הדחיפה הזו חייבת HTTPS אם השרת חשוף לאינטרנט. עד שיהיה TLS —
> אפשר להשאיר את `SB_HOST=127.0.0.1` ולהריץ את ה-agent דרך tunnel.

## ניתוח סיכונים

| סיכון | חומרה | הפחתה |
|---|---|---|
| **"Sign in to confirm you're not a bot"** | נמוך | סשן פעיל + עוגיות בכל הורדה (בדיוק מה שהקיפר מספק) |
| CAPTCHA/אימות בכניסה הראשונה מ-IP של דאטהסנטר | נמוך-בינוני | חד-פעמי; כניסה דרך tunnel/QR |
| ביטול סשן לאורך זמן | בינוני | הקיפר מרענן כל כמה מחזורים; אם נפל — צילום + התראה, כניסה חוזרת |
| **פריצה ל-VPS = חשיפת החשבון** (העוגיות) | **בינוני** | `HARDEN_SSH=1`, ufw, `chmod 600` לעוגיות, NoNewPrivileges ב-systemd |
| הורדות מהירות מדי מעוררות בדיקות | נמוך | קצב רגוע; ה-relay מגביל ריצות מקבילות |
| נעילה עצמית מ-SSH hardening | — | הסקריפט בודק authorized_keys לפני שמכבה סיסמאות, ומוריד את `sshd -t` לפני reload |

## מלכודות ידועות

- **Chrome ≥ 136** — אי אפשר לשלוט בו ב-CDP עם פרופיל ברירת המחדל;
  חייבים `--user-data-dir` ייעודי (הקיפר עושה את זה).
- **`chromium-browser` ב-Ubuntu המודרני הוא snap** — יכול להיכשל תחת
  systemd. לכן ברירת המחדל היא Google Chrome stable; אם בכל זאת רוצים
  Chromium — `CHROME_MODE=snap` (ו-`SB_CHROME_BIN=chromium` כבר נכתב ל-.env).
- **אין מסך בשרת** — הקיפר רץ עם `SB_XVFB=1` (או `--headless=new` אם
  מקבלים סיכון גבוה יותר לחסימה).
