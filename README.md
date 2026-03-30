# UAVChum

**Weather & Aviation Intelligence — no API keys required.**

UAVChum is a Go web app that brings together weather forecasts, drone flight assessments, and aviation data (METARs, TAFs, NOTAMs, SIGMETs) into a single clean interface. Everything runs off free, open data sources.

---

## Features

### Weather
- Current conditions with feels-like, humidity, wind, gusts, pressure, and cloud cover
- 24-hour hourly scroll
- 7-day forecast
- Interactive location map

### Drone
- Go / Marginal / No-Go flight assessment based on live weather
- 24-hour fly window with per-hour colour coding
- Pre-flight checklist
- Interactive airspace map with toggleable layers:
  - **OpenAIP** — controlled airspace for the UK, EU, and beyond (CTR, ATZ, MATZ, Restricted, Prohibited, Danger zones)
  - **FAA Class B/C/D** — US controlled airspace
  - **FAA LAANC grids** — UAS facility map / drone altitude ceilings
  - **TFRs** — active Temporary Flight Restrictions
  - **Airport advisory circles** — proximity warnings worldwide
- Data sources panel showing feature counts, live vs cached status, and last fetch time
- Local drone laws tile — links to the official regulator for US, CA, AU, NZ, and UK

### Aviation
- METAR with full decode (flight category, wind, visibility, ceiling, altimeter)
- TAF terminal forecast
- SIGMETs & AIRMETs
- Pilot Reports (PIREPs)
- NOTAMs

---

## Data Sources

| Source | Used for |
|--------|----------|
| [Open-Meteo](https://open-meteo.com) | Weather forecasts & current conditions |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | Location search |
| [OpenAIP](https://www.openaip.net) | EU/global airspace (cached 24 h) |
| [FAA ArcGIS](https://adds-faa.opendata.arcgis.com) | US Class B/C/D airspace & LAANC grids |
| [aviationweather.gov](https://aviationweather.gov) | METARs, TAFs, SIGMETs, PIREPs, TFRs |
| [Blitzortung](https://www.blitzortung.org) | Real-time lightning strikes |
| [ADS-B Exchange / adsb.lol](https://adsb.lol) | Live aircraft traffic |

No accounts, no API keys, no rate-limit tokens needed.

---

## Requirements

- Go 1.23+

```bash
go mod download
```

---

## Running

```bash
go run .
```

Or build and run:

```bash
go build -o uavchum .
./uavchum
```

Then open [http://localhost:5555](http://localhost:5555).

---

## Security Posture

Browser assets are served locally — no CDN dependencies:

- Leaflet loaded from repo-local static files
- Weather Icons loaded from repo-local static files

Go server security defaults:

- Strict CSP with per-request nonces (no `unsafe-inline` for scripts)
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS in production
- All API inputs validated with regex before use
- Rate limiting per IP: 2 req/s burst + per-endpoint per-minute limits
- `read_only` container filesystem, all capabilities dropped, `no-new-privileges`

For production behind Cloudflare Tunnel, set:

```bash
UAVCHUM_ENV=production
```

---

## Development

```bash
# Lint (requires golangci-lint)
make lint

# Static analysis
make vet

# Vulnerability scan (requires govulncheck)
make vuln
```

Install tools:

```bash
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install golang.org/x/vuln/cmd/govulncheck@latest
```

---

## Container (Docker/Podman)

#### Local container run (no tunnel)

```bash
docker build -t uavchum:local .
docker run --rm -it -p 5555:5555 -e UAVCHUM_ENV=production uavchum:local
```

Then open [http://localhost:5555](http://localhost:5555).

#### Cloudflare Tunnel deployment (compose)

See `deploy/cloudflare.md` for the recommended Cloudflare Tunnel rollout.

`compose.yml` runs the app **and** a `cloudflared` tunnel sidecar, and **does not expose any ports to the host**.
It requires a real Cloudflare `TUNNEL_TOKEN` in your `.env`.

#### Ansible deploy

An Ansible playbook is provided to sync and redeploy to the server:

```bash
ansible-playbook deploy/deploy.yml
```

Requires the `ansible.posix` collection (`ansible-galaxy collection install ansible.posix`).
The playbook rsyncs all files to `~/uavchum` on the `rocky` host (from your SSH config),
then runs `podman compose build --no-cache && podman compose up -d --force-recreate`
if anything changed. The `.env` file on the server is never overwritten.

---

## Troubleshooting

### Podman stale lock errors after reboot / SSH logout

Running `podman ps` may print errors like:

```
ERRO[0000] Refreshing container <id>: acquiring lock 1 for container <id>: file exists
```

**Why this happens.** Podman is daemonless — systemd-logind destroys `/run/user/$UID/` on logout,
wiping lock files. The containers themselves are unaffected; this is a known upstream bug
([#16784](https://github.com/containers/podman/issues/16784)).

**Permanent fix** (run once on the Rocky host):

```bash
loginctl enable-linger $USER
```

**Immediate recovery:**

```bash
podman system renumber
podman compose down && podman compose up -d
```

---

## Project Structure

```
.
├── main.go             # Server, routing, startup
├── middleware.go       # CSP nonce, security headers
├── decode.go           # WMO codes, METAR decode, drone assessment
├── weather.go          # /api/weather
├── aviation.go         # /api/aviation (METAR/TAF/NOTAM/SIGMET/PIREP)
├── airspace.go         # /api/airspace + OpenAIP cache
├── adsb.go             # /api/adsb
├── lightning.go        # Blitzortung goroutine + /api/lightning
├── search.go           # /api/search, /api/station, /api/flightroute
├── go.mod / go.sum
├── Dockerfile          # Multi-stage: builder + alpine runtime (~20 MB image)
├── compose.yml         # App + cloudflared tunnel sidecar
├── Makefile            # build / lint / vet / vuln / deploy
├── .golangci.yml       # Linter config
├── deploy/
│   ├── deploy.yml      # Ansible deploy playbook
│   ├── inventory.ini   # Ansible inventory (rocky host)
│   ├── cloudflare.md   # Rollout instructions
│   ├── setup.sh        # Bare-metal setup (no container)
│   └── uavchum.service # systemd unit
├── static/
│   ├── app.js          # Frontend logic
│   ├── style.css
│   ├── sw.js           # Service worker
│   └── manifest.json
└── templates/
    └── index.html      # Single-page app shell
```

## Live Site

https://uavchum.hehaw.net/
