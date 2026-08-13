#!/bin/bash
# ============================================================
#  פריסה מלאה של chat-downloader-bot על Ubuntu VPS (22.04/24.04)
#
#  הרצה כשורש, מהתיקייה chat-downloader-bot:
#    sudo bash deploy-vps.sh
#
#  משתנים אופציונליים:
#    SB_APP_DIR=/opt/sb        היכן להתקין (ברירת מחדל)
#    SB_RUN_USER=sb            משתמש השירות (ברירת מחדל)
#    SB_SYNC_TOKEN=<sod>       טוקן סנכרון העוגיות (נוצר אוטומטית אם ריק)
#    SSH_PORT=22               פורט SSH ל-ufw
#    CHROME_MODE=chrome|snap   איך להתקין את הדפדפן (ברירת מחדל: chrome)
#    HARDEN_SSH=1              הקשחת SSH (PasswordAuthentication no) — רק אם
#                              קיים מפתח authorized_keys (אחרת מדלגים!).
#    SB_XVFB=1                 להריץ את הקיפר תחת xvfb (מומלץ לשרת ללא מסך)
#
#  בטוח להרצה חוזרת — כל שלב אידמפוטנטי.
# ============================================================
set -euo pipefail

APP_DIR="${SB_APP_DIR:-/opt/sb}"
RUN_USER="${SB_RUN_USER:-sb}"
SSH_PORT="${SSH_PORT:-22}"
CHROME_MODE="${CHROME_MODE:-chrome}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo -e "\033[1;34m[deploy]\033[0m $*"; }
warn() { echo -e "\033[1;33m[deploy!]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[deploy✓]\033[0m $*"; }

# ---------- 0. בדיקות מקדימות ----------
if [[ "$(id -u)" != "0" ]]; then
  echo "❌ הרץ כשורש: sudo bash deploy-vps.sh"; exit 1
fi
if [[ ! -f "$SRC_DIR/storage-server.js" ]]; then
  echo "❌ הרץ את הסקריפט מתוך התיקייה chat-downloader-bot"; exit 1
fi

# ---------- 1. עדכון והתקנות בסיס ----------
export DEBIAN_FRONTEND=noninteractive
log "מעדכן חבילות..."
apt-get update -qq
apt-get install -y -qq curl wget ca-certificates unzip openssl xvfb

# ---------- 2. Node.js 22+ ----------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.version.split(".")[0].slice(1)')" -lt 22 ]]; then
  log "מתקין Node.js 22 (nodesource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
else
  ok "Node.js כבר קיים: $(node -v)"
fi

# ---------- 3. דפדפן ----------
install_chrome() {
  if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
    ok "Google Chrome כבר מותקן"; return
  fi
  log "מוריד Google Chrome stable..."
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -i /tmp/chrome.deb >/dev/null 2>&1 || apt-get install -f -y -qq >/dev/null
  ok "Google Chrome מותקן"
}
install_snap_chromium() {
  if command -v chromium >/dev/null 2>&1; then ok "Chromium כבר מותקן"; return; fi
  log "מתקין Chromium (snap)..."
  apt-get install -y -qq snapd
  snap install chromium
  ok "Chromium מותקן (snap)"
}
case "$CHROME_MODE" in
  chrome) install_chrome ;;
  snap)   install_snap_chromium ;;
  *)      warn "CHROME_MODE לא מוכר ($CHROME_MODE) — משתמש ב-chrome"; install_chrome ;;
esac

# ---------- 4. משתמש השירות ----------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log "יוצר משתמש שירות: $RUN_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
else
  ok "משתמש $RUN_USER קיים"
fi

# ---------- 5. העתקת הפרויקט ----------
log "מעתיק לפרויקט ל-$APP_DIR (מנקה storage/data קודמים)..."
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR"/storage "$APP_DIR"/data "$APP_DIR"/.env
cp -r "$SRC_DIR"/. "$APP_DIR"/
# רק הקבצים הנדרשים — לא קבצי ריצה ישנים
rm -f "$APP_DIR"/login-page.png
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
ok "הפרויקט ב-$APP_DIR"

# ---------- 6. קובץ הגדרות (.env) ----------
if [[ -n "${SB_SYNC_TOKEN:-}" ]]; then TOKEN="$SB_SYNC_TOKEN"; else TOKEN="$(openssl rand -hex 24)"; fi
cat > "$APP_DIR/.env" <<EOF
SB_SYNC_TOKEN=$TOKEN
SB_COOKIES_STORE=$APP_DIR/data/cookies.txt
SB_HOST=127.0.0.1
SB_PORT=9796
SB_PROFILE_DIR=$APP_DIR/browser
$( [[ "$CHROME_MODE" == "snap" ]] && echo "SB_CHROME_BIN=chromium" )
EOF
chmod 600 "$APP_DIR/.env"
chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env"
ok "קובץ הגדרות נכתב (הטוקן שלך: $TOKEN) — שמור אותו!"

# ---------- 7. שירותי systemd ----------
cat > /etc/systemd/system/sb-keeper.service <<EOF
[Unit]
Description=SB cookie keeper (YouTube session)
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
$( [[ -n "${SB_XVFB:-}" || "$CHROME_MODE" == "snap" ]] && echo "Environment=SB_XVFB=1" )
ExecStart=/usr/bin/node $APP_DIR/vps-cookie-keeper.js
Restart=on-failure
RestartSec=15
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/sb-server.service <<EOF
[Unit]
Description=SB storage server
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/storage-server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sb-server >/dev/null 2>&1
systemctl enable sb-keeper >/dev/null 2>&1
ok "שירותים sb-server / sb-keeper נרשמו"

# ---------- 8. חומת אש (ufw) ----------
if command -v ufw >/dev/null 2>&1; then
  log "מגדיר ufw (מאפשר SSH:$SSH_PORT, 80, 443)..."
  ufw default deny incoming >/dev/null
  ufw allow "$SSH_PORT"/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null 2>&1 || warn "ufw enable נכשל — בדוק ידנית"
  ok "ufw פעיל. פורט 9796 חסום מבחוץ (נגיש רק דרך proxy/TLS בשלב מאוחר יותר)"
else
  warn "ufw לא מותקן — התקן והפעל: apt install ufw"
fi

# ---------- 9. הקשחת SSH (אופציונלית ובטוחה) ----------
if [[ "${HARDEN_SSH:-0}" == "1" ]]; then
  KEYS_FOUND=0
  grep -q "ssh-rsa\|ssh-ed25519\|ecdsa-" /root/.ssh/authorized_keys 2>/dev/null && KEYS_FOUND=1
  if [[ "$KEYS_FOUND" == "1" ]]; then
    log "מקשח SSH (סיסמאות כבויות)..."
    cat > /etc/ssh/sshd_config.d/99-sb-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      ok "SSH הוקשח (מפתחות בלבד)"
    else
      warn "sshd -t נכשל — מבטל את ההקשחה (קובץ נשאר אבל לא נטען)"
    fi
  else
    warn "HARDEN_SSH=1 אבל אין מפתחות ב-/root/.ssh/authorized_keys — מדלג (נגד נעילה עצמית!)"
  fi
fi

# ---------- 10. הדפסת השלבים הבאים ----------
echo
echo "============================================================"
echo "  הפריסה הושלמה. מה עכשיו:"
echo "============================================================"
echo "  1) כניסה ליוטיוב (בפעם הראשונה):"
echo "     cd $APP_DIR && sudo -u $RUN_USER node vps-cookie-keeper.js --login"
echo "     (במחשב שלך: ssh -L 9222:127.0.0.1:9222 root@<vps-ip> ואז"
echo "      לפתוח http://127.0.0.1:9222 בדפדפן מקומי → טאב YouTube → להתחבר)"
echo
echo "  2) בדיקת הקיפר:"
echo "     sudo -u $RUN_USER node $APP_DIR/vps-cookie-keeper.js --once"
echo "     → צריך להדפיס: ייצאתי N עוגיות -> $APP_DIR/data/cookies.txt"
echo
echo "  3) הפעלת השירותים:"
echo "     systemctl start sb-keeper sb-server"
echo "     systemctl status sb-keeper sb-server"
echo
echo "  4) בדיקת שרת האחסון (מקומית על ה-VPS):"
echo "     curl -s http://127.0.0.1:9796/api"
echo "     curl -s -X POST http://127.0.0.1:9796/api/save \\"
echo "          -H 'content-type: application/json' \\"
echo "          -d '{\"url\":\"https://www.youtube.com/watch?v=aqz-KE-bpKQ\"}'"
echo
echo "  הטוקן שלך (ל-cookie-agent אם תרצה גיבוי מהמחשב): $TOKEN"
echo "============================================================"
