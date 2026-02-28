# UAVChum

**Weather & Aviation Intelligence — no API keys required.**

UAVChum is a Flask web app that brings together weather forecasts, drone flight assessments, and aviation data (METARs, TAFs, NOTAMs, SIGMETs) into a single clean interface. Everything runs off free, open data sources.

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
- Local drone laws tile — links to the official regulator for US, CA, AU, NZ, and UK; falls back to drone-laws.com for all other countries

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

No accounts, no API keys, no rate-limit tokens needed.

---

## Requirements

- Python 3.11+
- Dependencies in `requirements.txt`

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## Running

```bash
python app.py
```

Then open [http://localhost:5555](http://localhost:5555).

### Container (Docker/Podman)

This repo supports two container workflows:

#### Local container run (no tunnel)

Build and run the app container, publishing port **5555** to the host:

```bash
docker build -t uavchum:local .
docker run --rm -it -p 5555:5555 -e SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')" uavchum:local
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

## Project Structure

```
.
├── app.py              # Flask backend & API routes
├── requirements.txt    # Python dependencies
├── Dockerfile          # Container build
├── compose.yml         # App + cloudflared tunnel sidecar
├── deploy/
│   ├── deploy.yml      # Ansible deploy playbook
│   ├── inventory.ini   # Ansible inventory (rocky host)
│   ├── cloudflare.md   # Rollout instructions
│   ├── setup.sh        # Non-container setup
│   └── uavchum.service
├── static/
│   ├── app.js          # Frontend logic
│   ├── style.css       # Styles
│   ├── sw.js           # Service worker
│   └── manifest.json
└── templates/
    └── index.html      # Single-page app shell
```


## Live Site

You can use this site today

https://uavchum.hehaw.net/