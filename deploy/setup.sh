#!/usr/bin/env bash
# UAVChum — server setup (Rocky Linux 8/9)
# Run as root on a fresh VPS, then follow the Cloudflare steps below.
set -euo pipefail

APP_DIR=/opt/uavchum
APP_USER=uavchum

# ── System deps ─────────────────────────────────────────────────────
dnf update -q -y
dnf install -y python3 python3-pip

# ── App user ────────────────────────────────────────────────────────
id "$APP_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$APP_USER"

# ── Deploy app files ─────────────────────────────────────────────────

mkdir -p "$APP_DIR"
# rsync -a --exclude '.git' --exclude '__pycache__' ./ "$APP_DIR/"

# ── Python venv ─────────────────────────────────────────────────────
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" -q

# ── Environment file ────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo "SECRET_KEY=$SECRET" > "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo "Generated SECRET_KEY in $APP_DIR/.env"
fi

# ── Permissions ─────────────────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── Systemd service ─────────────────────────────────────────────────
cp "$APP_DIR/deploy/uavchum.service" /etc/systemd/system/uavchum.service
systemctl daemon-reload
systemctl enable uavchum
systemctl restart uavchum
systemctl status uavchum --no-pager

echo ""
echo "App running. Next: install cloudflared and point your tunnel at http://127.0.0.1:5555"
echo "See deploy/cloudflare.md for instructions."
