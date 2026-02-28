# Cloudflare Deployment

## Container deployment (recommended)

The app ships with `compose.yml` which runs UAVChum and a Cloudflare Tunnel
sidecar together. No ports are exposed to the host. The tunnel container talks
to the app container over a private internal network (`skynet`).

If you just want to run the app locally and access it at `http://localhost:5555`,
use `docker run -p 5555:5555 ...` (see the repo `README.md`).

### 1. Install Podman (recommended — rootless, no root daemon)

```bash
# Rocky Linux 8/9
dnf install -y podman python3-pip
pip3 install podman-compose --user
# Make sure ~/.local/bin is in PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Docker works too — the compose file is identical:

```bash
# Rocky Linux 8/9
dnf install -y docker
systemctl enable --now docker
```

### 2. Create the Cloudflare Tunnel

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Networks → Tunnels**
2. Click **Add a tunnel** → **Cloudflared**
3. Name it `uavchum`
4. Copy the tunnel token shown (long string starting with `eyJ...`)
5. Under **Public Hostname**, add:
   - Subdomain: `uavchum` (or whatever you want)
   - Domain: your domain
   - Service: `http://app:5555` ← compose service name, not localhost

### 3. Create the .env file on the server

```bash
cat > /home/cass/uavchum/.env << EOF
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
TUNNEL_TOKEN=paste-your-tunnel-token-here
EOF
chmod 600 /home/cass/uavchum/.env
```

### 4. Deploy

```bash
cd /opt/uavchum

# Podman
podman compose up -d --build

# Docker
docker compose up -d --build
```

The tunnel container waits for the app to pass its health check before
connecting — startup order is handled automatically.

### 5. Verify

```bash
# Podman
podman compose logs -f

# Docker
docker compose logs -f
```

### Updates

```bash
# Podman
podman compose up -d --build

# Docker
docker compose up -d --build
```

---

## Non-container deployment (systemd)

If you'd rather run directly on the host without containers:

1. Run `sudo bash deploy/setup.sh` to provision the server and install the systemd service
2. Install `cloudflared` manually:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.rpm \
    -o cloudflared.rpm && rpm -i cloudflared.rpm
cloudflared tunnel login
cloudflared tunnel create uavchum
```

3. Point the tunnel ingress at `http://127.0.0.1:5555` instead of `http://app:5555`

---

## Cloudflare dashboard settings

| Setting | Value |
|---------|-------|
| SSL/TLS mode | Full |
| Always Use HTTPS | On |
| Cache Rules | Bypass `/api/*`, cache `/static/*` |
| Rate Limiting | Add a rule for `/api/*` at 100 req/min to supplement app-level limits |
| Bot Fight Mode | On |
