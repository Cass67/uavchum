#!/usr/bin/env bash
# UAVChum — server setup (Rocky Linux 8/9, bare-metal / no container)
# Run as root on a fresh VPS, then follow the Cloudflare steps in deploy/cloudflare.md.
set -euo pipefail

APP_DIR=/opt/uavchum
APP_USER=uavchum
GO_VERSION=1.23.5

# ── System deps ──────────────────────────────────────────────────────
dnf update -q -y
dnf install -y wget tar

# ── Install Go ───────────────────────────────────────────────────────
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION}"; then
  wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -O /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
fi

# ── App user ─────────────────────────────────────────────────────────
id "$APP_USER" &>/dev/null || useradd --system --no-create-home --shell /bin/false "$APP_USER"

# ── Deploy app files ──────────────────────────────────────────────────
mkdir -p "$APP_DIR"
# rsync -a --exclude '.git' --exclude '*.test' ./ "$APP_DIR/"

# ── Build binary ─────────────────────────────────────────────────────
(cd "$APP_DIR" && /usr/local/go/bin/go build -ldflags="-s -w" -o uavchum .)

# ── Environment file ─────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  cat >"$APP_DIR/.env" <<'EOF'
UAVCHUM_ENV=production
TUNNEL_TOKEN=replace-with-your-cloudflare-tunnel-token
# Cloudflare Turnstile keys — add your real keys here
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
EOF
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env — edit TUNNEL_TOKEN before starting the tunnel."
fi

# ── Permissions ──────────────────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── Systemd service ──────────────────────────────────────────────────
cp "$APP_DIR/deploy/uavchum.service" /etc/systemd/system/uavchum.service
systemctl daemon-reload
systemctl enable uavchum
systemctl restart uavchum
systemctl status uavchum --no-pager

echo ""
echo "App running. Next: install cloudflared and point your tunnel at http://127.0.0.1:5555"
echo "See deploy/cloudflare.md for instructions."
