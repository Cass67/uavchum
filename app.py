#!/usr/bin/env python3
"""UAVChum — Weather & Aviation Intelligence. Zero API keys."""

import datetime
import json
import logging
import math
import os
import secrets
import threading
import time
from collections import deque
from functools import lru_cache
from http.cookiejar import DefaultCookiePolicy
from re import fullmatch

import defusedxml.ElementTree as ET  # noqa: N817
import requests
from flask import Flask, g, jsonify, render_template, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = False
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["500 per day", "100 per hour", "2 per second"],
    storage_uri=os.environ.get("RATELIMIT_STORAGE_URL", "memory://"),
)

# ── HTTP Session with connection pooling ─────────────────────────────
_session = requests.Session()
_retry_strategy = Retry(
    total=0,
    backoff_factor=0,
    status_forcelist=[],
)
_adapter = HTTPAdapter(max_retries=_retry_strategy, pool_connections=10, pool_maxsize=10)
_session.mount("http://", _adapter)
_session.mount("https://", _adapter)
_session.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))
_session.max_redirects = 3

# ── OpenAIP Cache ───────────────────────────────────────────────────
_openaip_cache: dict = {}
_openaip_lock = threading.Lock()
_OPENAIP_TTL = 3600 * 24  # 24 hours

# ── Input validation ────────────────────────────────────────────────
_ICAO_RE = r"[A-Z][A-Z0-9]{2,3}"
_CC_RE = r"[A-Z]{2}"
_SEARCH_MAX = 200


def _valid_lat(v) -> bool:
    return v is not None and -90.0 <= v <= 90.0


def _valid_lon(v) -> bool:
    return v is not None and -180.0 <= v <= 180.0


def _valid_station(s: str) -> bool:
    return bool(fullmatch(_ICAO_RE, s))


def _valid_country(s: str) -> bool:
    return bool(fullmatch(_CC_RE, s))


# ── Security headers ────────────────────────────────────────────────
@app.after_request
def set_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = (
        "geolocation=(self), microphone=(), camera=(), clipboard-write=(self)"
    )
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    response.headers["X-XSS-Protection"] = "0"
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    nonce = getattr(g, "csp_nonce", "")
    csp = (
        "default-src 'self'; "
        "base-uri 'none'; "
        "object-src 'none'; "
        "frame-ancestors 'none'; "
        "frame-src 'none'; "
        "form-action 'self'; "
        "manifest-src 'self'; "
        "worker-src 'self'; "
        f"script-src 'self' https://unpkg.com 'nonce-{nonce}'; "
        "script-src-attr 'none'; "
        "style-src 'self' https://unpkg.com "
        "https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
        "style-src-attr 'unsafe-inline'; "
        "font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
        "img-src 'self' data: https://*.tile.openstreetmap.org "
        "https://*.basemaps.cartocdn.com "
        "https://tilecache.rainviewer.com; "
        "connect-src 'self' https://nominatim.openstreetmap.org "
        "https://fonts.googleapis.com https://*.basemaps.cartocdn.com "
        "https://cdnjs.cloudflare.com https://unpkg.com "
        "https://api.rainviewer.com"
    )
    if request.is_secure:
        csp += "; upgrade-insecure-requests"
    response.headers["Content-Security-Policy"] = csp
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if request.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.before_request
def set_csp_nonce():
    g.csp_nonce = secrets.token_urlsafe(16)


# ── Geometry helpers ────────────────────────────────────────────────
def _geom_bbox(geom):
    """Return (minlon, minlat, maxlon, maxlat) for any GeoJSON geometry."""
    gt = geom.get("type", "")
    coords = geom.get("coordinates", [])
    flat = []
    if gt == "Point":
        flat = [coords]
    elif gt in ("LineString", "MultiPoint"):
        flat = coords
    elif gt == "Polygon":
        flat = [c for ring in coords for c in ring]
    elif gt == "MultiPolygon":
        flat = [c for poly in coords for ring in poly for c in ring]
    elif gt == "MultiLineString":
        flat = [c for line in coords for c in line]
    pts = [c for c in flat if len(c) >= 2]
    if not pts:
        return None
    lons = [c[0] for c in pts]
    lats = [c[1] for c in pts]
    return (min(lons), min(lats), max(lons), max(lats))


def fetch_openaip(country_code: str) -> tuple:
    """Fetch and cache OpenAIP airspace GeoJSON for a country (24 h TTL).

    Returns (data, was_cached, cache_ts).
    """
    cc = country_code.lower()
    now = time.time()
    with _openaip_lock:
        cached = _openaip_cache.get(cc)
        if cached and now - cached["ts"] < _OPENAIP_TTL:
            return cached["data"], True, int(cached["ts"])
    try:
        url = (
            f"https://storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f/{cc}_asp.geojson"
        )
        r = _session.get(url, timeout=30)
        if r.status_code == 200:
            data = r.json()
            ts = int(time.time())
            with _openaip_lock:
                _openaip_cache[cc] = {"data": data, "ts": ts}
            return data, False, ts
    except requests.RequestException:
        logger.warning("OpenAIP fetch failed for country %s", cc)
    return None, False, None


@lru_cache(maxsize=512)
def _country_from_latlon(lat_r: float, lon_r: float) -> str:
    """Reverse-geocode a coarse lat/lon (1° grid) to a 2-letter ISO country code.

    Results are cached in-process; Nominatim is only hit once per grid cell.
    Returns '' if lookup fails so callers can fall through gracefully.
    """
    try:
        r = _session.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"lat": lat_r, "lon": lon_r, "format": "json", "zoom": 3},
            headers={"User-Agent": "UAVChum/1.0 (uavchum.app)"},
            timeout=5,
        )
        if r.status_code == 200:
            return r.json().get("address", {}).get("country_code", "").upper()
    except requests.RequestException:
        pass
    return ""


def filter_openaip(data, lat, lon, delta):
    """Filter OpenAIP features to the request bbox, drone-relevant only."""
    if not data:
        return []
    q_minlon, q_maxlon = lon - delta, lon + delta
    q_minlat, q_maxlat = lat - delta, lat + delta

    # Lower type number = higher drone priority (Prohibited > Restricted > Danger > CTR …)
    type_prio = {
        3: 0,
        1: 1,
        2: 2,
        4: 3,
        13: 4,
        14: 5,
        18: 6,
        28: 7,
        5: 8,
        7: 8,
        26: 9,
        21: 10,
        6: 10,
        0: 11,
    }

    results = []
    for feat in data.get("features", []):
        geom = feat.get("geometry")
        if not geom:
            continue
        bbox = _geom_bbox(geom)
        if not bbox:
            continue
        fminlon, fminlat, fmaxlon, fmaxlat = bbox
        if fmaxlon < q_minlon or fminlon > q_maxlon or fmaxlat < q_minlat or fminlat > q_maxlat:
            continue
        p = feat.get("properties", {})
        t = p.get("type", 99)
        # Skip features whose floor is above FL100 (irrelevant for drones)
        lower = p.get("lowerLimit", {})
        unit = lower.get("unit", 1)  # 1=ft, 6=FL
        val = lower.get("value") or 0
        floor_ft = val * 100 if unit == 6 else val
        if floor_ft > 10000 and t not in (1, 2, 3):
            continue
        results.append((type_prio.get(t, 99), feat))

    results.sort(key=lambda x: x[0])
    return [f for _, f in results[:250]]


# ── WMO Weather Codes ───────────────────────────────────────────────
WMO = {
    0: ("Clear sky", "wi-day-sunny", "clear"),
    1: ("Mainly clear", "wi-day-sunny-overcast", "clear"),
    2: ("Partly cloudy", "wi-cloud", "cloud"),
    3: ("Overcast", "wi-cloudy", "cloud"),
    45: ("Fog", "wi-fog", "fog"),
    48: ("Rime fog", "wi-fog", "fog"),
    51: ("Light drizzle", "wi-sprinkle", "rain"),
    53: ("Moderate drizzle", "wi-sprinkle", "rain"),
    55: ("Dense drizzle", "wi-sprinkle", "rain"),
    56: ("Freezing drizzle", "wi-rain-mix", "rain"),
    57: ("Heavy freezing drizzle", "wi-rain-mix", "rain"),
    61: ("Slight rain", "wi-rain", "rain"),
    63: ("Moderate rain", "wi-rain", "rain"),
    65: ("Heavy rain", "wi-rain-wind", "rain"),
    66: ("Freezing rain", "wi-rain-mix", "rain"),
    67: ("Heavy freezing rain", "wi-rain-mix", "rain"),
    71: ("Slight snow", "wi-snow", "snow"),
    73: ("Moderate snow", "wi-snow", "snow"),
    75: ("Heavy snow", "wi-snow-wind", "snow"),
    77: ("Snow grains", "wi-snow", "snow"),
    80: ("Slight showers", "wi-showers", "rain"),
    81: ("Moderate showers", "wi-showers", "rain"),
    82: ("Violent showers", "wi-storm-showers", "rain"),
    85: ("Slight snow showers", "wi-snow", "snow"),
    86: ("Heavy snow showers", "wi-snow-wind", "snow"),
    95: ("Thunderstorm", "wi-thunderstorm", "storm"),
    96: ("Thunderstorm + hail", "wi-thunderstorm", "storm"),
    99: ("Thunderstorm + heavy hail", "wi-thunderstorm", "storm"),
}

WIND_DIRS = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
]


def decode_wmo(code):
    d = WMO.get(code, ("Unknown", "wi-na", "unknown"))
    return {"desc": d[0], "icon": d[1], "group": d[2]}


def wind_dir_label(deg):
    if deg is None:
        return "VRB"
    return WIND_DIRS[round(deg / 22.5) % 16]


def hpa_to_inhg(hpa):
    return round(hpa * 0.02953, 2)


def meters_to_ft(m):
    return round(m * 3.28084)


def _civil_twilight_utc(lat: float, lon: float, date_str: str) -> tuple[str | None, str | None]:
    """Return (civil_dawn_utc_iso, civil_dusk_utc_iso) for the given date.

    Uses the NOAA/Spencer solar position algorithm.  Returns (None, None) for
    polar regions where civil twilight does not occur.
    """
    date = datetime.date.fromisoformat(date_str[:10])
    doy = date.timetuple().tm_yday
    _b = 2 * math.pi * (doy - 1) / 365
    # Solar declination — Spencer 1971
    dec = math.degrees(
        0.006918
        - 0.399912 * math.cos(_b)
        + 0.070257 * math.sin(_b)
        - 0.006758 * math.cos(2 * _b)
        + 0.000907 * math.sin(2 * _b)
        - 0.002697 * math.cos(3 * _b)
        + 0.001480 * math.sin(3 * _b)
    )
    # Equation of time (minutes)
    eot = 229.18 * (
        0.000075
        + 0.001868 * math.cos(_b)
        - 0.032077 * math.sin(_b)
        - 0.014615 * math.cos(2 * _b)
        - 0.040890 * math.sin(2 * _b)
    )
    solar_noon_utc = 12.0 - lon / 15.0 - eot / 60.0
    lat_r = math.radians(lat)
    dec_r = math.radians(dec)
    # Zenith angle for civil twilight = 96° (sun 6° below horizon)
    cos_ha = (math.cos(math.radians(96)) - math.sin(lat_r) * math.sin(dec_r)) / (
        math.cos(lat_r) * math.cos(dec_r)
    )
    if abs(cos_ha) > 1:
        return None, None
    ha_h = math.degrees(math.acos(cos_ha)) / 15.0

    def _to_iso(utc_h: float) -> str:
        utc_h = utc_h % 24
        h, rem = divmod(utc_h, 1)
        m, srem = divmod(rem * 60, 1)
        s = int(srem * 60)
        return datetime.datetime(
            date.year,
            date.month,
            date.day,
            int(h),
            int(m),
            s,
            tzinfo=datetime.UTC,
        ).isoformat()

    return _to_iso(solar_noon_utc - ha_h), _to_iso(solar_noon_utc + ha_h)


# ── METAR Decoder ───────────────────────────────────────────────────
def decode_metar(m):
    """Parse aviationweather.gov METAR JSON into human-readable fields."""
    decoded = {}
    decoded["raw"] = m.get("rawOb", "")
    decoded["station"] = m.get("icaoId", "")
    decoded["name"] = m.get("name", "")
    decoded["flight_cat"] = m.get("fltCat", "")
    decoded["time"] = m.get("reportTime", "")

    temp_c = m.get("temp")
    dewp_c = m.get("dewp")
    if temp_c is not None:
        decoded["temp_c"] = temp_c
        decoded["temp_f"] = round(temp_c * 9 / 5 + 32)
    if dewp_c is not None:
        decoded["dewp_c"] = dewp_c
        decoded["dewp_f"] = round(dewp_c * 9 / 5 + 32)

    wdir = m.get("wdir")
    wspd = m.get("wspd")
    wgst = m.get("wgst")
    decoded["wind_dir"] = wind_dir_label(wdir) if wdir != "VRB" else "VRB"
    decoded["wind_dir_deg"] = wdir
    decoded["wind_speed_kt"] = wspd
    decoded["wind_gust_kt"] = wgst

    vis = m.get("visib")
    decoded["visibility"] = f"{vis} SM" if vis else "N/A"

    alt = m.get("altim")
    if alt is not None:
        decoded["altimeter_hpa"] = alt
        decoded["altimeter_inhg"] = hpa_to_inhg(alt)

    clouds = m.get("clouds", [])
    if clouds:
        decoded["clouds"] = [
            {"cover": c.get("cover", ""), "base": c.get("base", ""), "type": c.get("type", "")}
            for c in clouds
        ]
    else:
        cover = m.get("cover", "")
        decoded["clouds"] = [{"cover": cover, "base": "", "type": ""}] if cover else []

    elev = m.get("elev")
    if elev is not None:
        decoded["elevation_m"] = elev
        decoded["elevation_ft"] = meters_to_ft(elev)

    decoded["wx_string"] = m.get("wxString", "")
    decoded["lat"] = m.get("lat")
    decoded["lon"] = m.get("lon")

    return decoded


# ── Drone / UAV Assessment ──────────────────────────────────────────
def _factor(name, value, status, note):
    return {"name": name, "value": value, "status": status, "note": note}


def _wind_factor(ws_kmh, ws):
    if ws_kmh <= 20:
        return _factor(
            "Wind",
            f"{round(ws_kmh)} km/h ({round(ws)} kn)",
            "good",
            "Light winds — safe for most drones",
        )
    if ws_kmh <= 35:
        return _factor(
            "Wind",
            f"{round(ws_kmh)} km/h ({round(ws)} kn)",
            "caution",
            "Moderate winds — small drones will struggle",
        )
    return _factor(
        "Wind",
        f"{round(ws_kmh)} km/h ({round(ws)} kn)",
        "danger",
        "Strong winds — unsafe for most consumer drones",
    )


def _gust_factor(wg_kmh, wg):
    if wg_kmh <= 30:
        return _factor(
            "Gusts", f"{round(wg_kmh)} km/h ({round(wg)} kn)", "good", "Gusts within safe limits"
        )
    if wg_kmh <= 45:
        return _factor(
            "Gusts",
            f"{round(wg_kmh)} km/h ({round(wg)} kn)",
            "caution",
            "Gusty — expect instability and drift",
        )
    return _factor(
        "Gusts", f"{round(wg_kmh)} km/h ({round(wg)} kn)", "danger", "Severe gusts — do not fly"
    )


def _gust_ratio_factor(ws_kn: float, wg_kn: float) -> dict | None:
    """Return a gust-variability factor when the gust/wind ratio is high."""
    if ws_kn < 3:
        return None
    ratio = wg_kn / ws_kn
    if ratio < 2.0:
        return None
    ratio_str = f"{ratio:.1f}× ratio"
    if ratio >= 3.0:
        return _factor(
            "Gust Variability",
            ratio_str,
            "danger",
            "Extreme gust variability — sudden speed spikes, do not fly",
        )
    return _factor(
        "Gust Variability",
        ratio_str,
        "caution",
        "High gust variability — expect sudden, unpredictable speed changes",
    )


def _wind_shear_factor(ws_10m_kn: float, ws_80m_kn: float) -> dict | None:
    """Return a low-level wind shear factor when 80 m wind differs significantly from 10 m."""
    diff_kn = ws_80m_kn - ws_10m_kn
    diff_kmh = diff_kn * 1.852
    if diff_kn < 10:
        return None
    ws_80m_kmh = round(ws_80m_kn * 1.852)
    note_severe = (
        f"Severe LLWS (+{round(diff_kmh)} km/h above 10 m) — altitude changes will be violent"
    )
    note_caution = (
        f"Low-level wind shear (+{round(diff_kmh)} km/h above 10 m) — turbulence on ascent/descent"
    )
    if diff_kn >= 20:
        return _factor("Wind Shear", f"{ws_80m_kmh} km/h at 80 m", "danger", note_severe)
    return _factor("Wind Shear", f"{ws_80m_kmh} km/h at 80 m", "caution", note_caution)


def _density_alt_factor(temp_c: float, pressure_hpa: float, elev_m: float) -> dict:
    pa_ft = (1013.25 - pressure_hpa) * 27 + elev_m * 3.28084
    isa_c = 15 - (elev_m / 1000 * 6.5)
    da_ft = pa_ft + 120 * (temp_c - isa_c)
    val = f"{round(da_ft):,} ft"
    if da_ft < 3000:
        return _factor(
            "Density Altitude", val, "good", "Normal air density — full thrust available"
        )
    if da_ft < 6000:
        return _factor(
            "Density Altitude", val, "caution", "Reduced air density — drone may underperform"
        )
    return _factor(
        "Density Altitude",
        val,
        "danger",
        "Very high density altitude — significant thrust loss expected",
    )


def _precip_factor(precip, group):
    if precip == 0 and group not in ("rain", "snow", "storm"):
        return _factor("Precipitation", "None", "good", "Dry conditions")
    if precip < 1 and group != "storm":
        return _factor(
            "Precipitation",
            f"{precip} mm",
            "caution",
            "Light precipitation — most drones are not waterproof",
        )
    return _factor(
        "Precipitation",
        f"{precip} mm" if precip else group,
        "danger",
        "Active precipitation — risk of water damage",
    )


def _cloud_factor(cloud):
    if cloud <= 50:
        return _factor("Cloud Cover", f"{cloud}%", "good", "Good visual conditions")
    if cloud <= 80:
        return _factor(
            "Cloud Cover", f"{cloud}%", "caution", "Overcast — maintain visual line of sight"
        )
    return _factor(
        "Cloud Cover",
        f"{cloud}%",
        "caution",
        "Heavy overcast — limited contrast, harder to spot drone",
    )


def _temp_factor(temp):
    if 5 <= temp <= 40:
        return _factor("Temperature", f"{round(temp)}°C", "good", "Within normal operating range")
    if 0 <= temp < 5 or 40 < temp <= 45:
        return _factor(
            "Temperature", f"{round(temp)}°C", "caution", "Battery performance may be reduced"
        )
    note = (
        "Extreme temperature — battery failure risk, LiPo danger zone"
        if temp < 0
        else "Extreme heat — risk of overheating"
    )
    return _factor("Temperature", f"{round(temp)}°C", "danger", note)


def assess_drone(weather_data):  # noqa: C901
    """Evaluate current conditions for drone/UAV flying."""
    c = weather_data["current"]
    factors = []

    ws = c.get("wind_speed") or 0
    factors.append(_wind_factor(ws * 1.852, ws))

    wg = c.get("wind_gusts") or 0
    factors.append(_gust_factor(wg * 1.852, wg))

    ratio_f = _gust_ratio_factor(ws, wg)
    if ratio_f:
        factors.append(ratio_f)

    ws_80m = c.get("wind_80m")
    if ws_80m is not None:
        shear_f = _wind_shear_factor(ws, ws_80m)
        if shear_f:
            factors.append(shear_f)

    precip = c.get("precip") or 0
    group = c.get("group", "clear")
    factors.append(_precip_factor(precip, group))
    factors.append(_cloud_factor(c.get("cloud_cover") or 0))
    temp = c.get("temp") or 0
    factors.append(_temp_factor(temp))

    elev_m = weather_data.get("elevation")
    if elev_m is not None:
        pressure = c.get("pressure") or 1013.25
        factors.append(_density_alt_factor(temp, pressure, elev_m))

    if group == "storm":
        factors.append(
            _factor(
                "Severe Weather",
                c.get("desc", "Thunderstorm"),
                "danger",
                "Thunderstorms — do NOT fly",
            )
        )
    elif group == "fog":
        factors.append(
            _factor("Visibility", "Fog", "danger", "Fog — cannot maintain visual line of sight")
        )

    statuses = [f["status"] for f in factors]
    if "danger" in statuses:
        verdict, color, summary = "NO-GO", "red", "Conditions are unsafe for drone flight"
    elif statuses.count("caution") >= 2:
        verdict, color, summary = (
            "MARGINAL",
            "amber",
            "Fly with caution — multiple limiting factors",
        )
    elif "caution" in statuses:
        verdict, color, summary = "MARGINAL", "amber", "Mostly OK but check limiting factors"
    else:
        verdict, color, summary = "GO", "green", "Conditions are good for drone flight"

    # Hourly fly-window (next 24h)
    hourly_verdicts = []
    for h in weather_data.get("hourly", []):
        hw = h.get("wind", 0) * 1.852
        hg = h.get("gusts", 0) * 1.852
        hp = h.get("precip_prob", 0)
        hgroup = "clear"
        hdesc = h.get("desc", "")
        for _code, (wdesc, _icon, wgrp) in WMO.items():
            if wdesc == hdesc:
                hgroup = wgrp
                break
        block = hw > 35 or hg > 45 or hgroup in ("storm", "fog")
        issues = sum([hw > 20, hg > 30, hgroup in ("rain", "snow"), hp > 60])
        if block:
            status = "danger"
        elif issues >= 2:
            status = "caution"
        else:
            status = "good"
        hourly_verdicts.append({"time": h["time"], "status": status})

    return {
        "verdict": verdict,
        "color": color,
        "summary": summary,
        "factors": factors,
        "hourly": hourly_verdicts,
    }


# ── Routes ──────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html", csp_nonce=g.csp_nonce)


@app.route("/api/search")
@limiter.limit("60 per minute")
def api_search():
    q = request.args.get("q", "").strip()
    if not q or len(q) < 2:
        return jsonify([])
    if len(q) > _SEARCH_MAX:
        return jsonify({"error": "query too long"}), 400
    try:
        r = _session.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": q, "count": 10, "language": "en", "format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        return jsonify(
            [
                {
                    "name": x.get("name"),
                    "country": x.get("country", ""),
                    "country_code": x.get("country_code", ""),
                    "admin1": x.get("admin1", ""),
                    "lat": x["latitude"],
                    "lon": x["longitude"],
                    "elevation": x.get("elevation"),
                    "population": x.get("population"),
                    "timezone": x.get("timezone", ""),
                }
                for x in r.json().get("results", [])
            ]
        )
    except requests.RequestException:
        logger.exception("Search API error for query %r", q)
        return jsonify({"error": "Search unavailable"}), 502


@app.route("/api/weather")
@limiter.limit("30 per minute")
def api_weather():
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    if not _valid_lat(lat) or not _valid_lon(lon):
        return jsonify({"error": "valid lat/lon required"}), 400
    try:
        r = _session.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "current": ",".join(
                    [
                        "temperature_2m",
                        "relative_humidity_2m",
                        "apparent_temperature",
                        "precipitation",
                        "weather_code",
                        "wind_speed_10m",
                        "wind_direction_10m",
                        "wind_gusts_10m",
                        "surface_pressure",
                        "cloud_cover",
                        "is_day",
                    ]
                ),
                "hourly": ",".join(
                    [
                        "temperature_2m",
                        "precipitation_probability",
                        "weather_code",
                        "wind_speed_10m",
                        "wind_gusts_10m",
                        "wind_speed_80m",
                    ]
                ),
                "daily": ",".join(
                    [
                        "weather_code",
                        "temperature_2m_max",
                        "temperature_2m_min",
                        "precipitation_sum",
                        "precipitation_probability_max",
                        "wind_speed_10m_max",
                        "wind_gusts_10m_max",
                        "sunrise",
                        "sunset",
                        "uv_index_max",
                    ]
                ),
                "timezone": "auto",
                "wind_speed_unit": "kn",
                "forecast_hours": 24,
            },
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
    except requests.RequestException:
        logger.exception("Weather API error lat=%s lon=%s", lat, lon)
        return jsonify({"error": "Weather data unavailable"}), 502

    c = data.get("current")
    if not c:
        return jsonify({"error": "Unexpected response from weather API"}), 502
    wmo = decode_wmo(c.get("weather_code", 0))

    hourly = []
    h = data.get("hourly", {})
    times = h.get("time", [])
    wind_80m_vals = h.get("wind_speed_80m", [None] * len(times))
    for i in range(len(times)):
        try:
            hw = decode_wmo(h["weather_code"][i])
            hourly.append(
                {
                    "time": times[i],
                    "temp": h["temperature_2m"][i],
                    "precip_prob": h["precipitation_probability"][i],
                    "icon": hw["icon"],
                    "desc": hw["desc"],
                    "group": hw["group"],
                    "wind": h["wind_speed_10m"][i],
                    "gusts": h["wind_gusts_10m"][i],
                    "wind_80m": wind_80m_vals[i] if i < len(wind_80m_vals) else None,
                }
            )
        except (KeyError, IndexError):
            continue

    d = data.get("daily", {})
    forecast = []
    for i in range(len(d.get("time", []))):
        try:
            dw = decode_wmo(d["weather_code"][i])
            date_str = d["time"][i]
            civil_dawn, civil_dusk = _civil_twilight_utc(lat, lon, date_str)
            forecast.append(
                {
                    "date": date_str,
                    "high": d["temperature_2m_max"][i],
                    "low": d["temperature_2m_min"][i],
                    "desc": dw["desc"],
                    "icon": dw["icon"],
                    "group": dw["group"],
                    "precip": d["precipitation_sum"][i],
                    "precip_prob": d.get("precipitation_probability_max", [None] * 7)[i],
                    "wind_max": d["wind_speed_10m_max"][i],
                    "gusts_max": d["wind_gusts_10m_max"][i],
                    "sunrise": d["sunrise"][i],
                    "sunset": d["sunset"][i],
                    "uv": d.get("uv_index_max", [None] * 7)[i],
                    "civil_dawn": civil_dawn,
                    "civil_dusk": civil_dusk,
                }
            )
        except (KeyError, IndexError):
            continue

    # wind_80m is hourly-only; use first slot as a current proxy
    wind_80m_current = hourly[0]["wind_80m"] if hourly else None

    result = {
        "current": {
            "temp": c["temperature_2m"],
            "feels_like": c["apparent_temperature"],
            "humidity": c["relative_humidity_2m"],
            "precip": c["precipitation"],
            "pressure": c["surface_pressure"],
            "pressure_inhg": hpa_to_inhg(c["surface_pressure"]),
            "wind_speed": c["wind_speed_10m"],
            "wind_gusts": c["wind_gusts_10m"],
            "wind_dir": wind_dir_label(c.get("wind_direction_10m")),
            "wind_deg": c.get("wind_direction_10m"),
            "cloud_cover": c.get("cloud_cover"),
            "is_day": c.get("is_day", 1),
            "weather_code": c.get("weather_code", 0),
            "wind_80m": wind_80m_current,
            **wmo,
        },
        "hourly": hourly,
        "forecast": forecast,
        "timezone": data.get("timezone", ""),
        "elevation": data.get("elevation"),
    }

    result["drone"] = assess_drone(result)
    return jsonify(result)


def _notam_portal(station: str) -> tuple[str, str]:
    """Return (url, label) for the public NOTAM portal serving this ICAO station."""
    s = station.upper()
    if s.startswith("K") or s.startswith("P"):
        return "https://notams.aim.faa.gov/notamSearch/", "FAA NOTAM Search"
    if s.startswith("C"):
        return "https://www.navcanada.ca/en/notam.aspx", "NAV CANADA"
    if s.startswith("EG"):
        return "https://nats-uk.ead-it.com/cms-nats/opencms/en/NOTAM/", "UK AIS NOTAM"
    if s[0] in ("E", "L", "B"):
        return "https://www.ead.eurocontrol.int/", "EUROCONTROL EAD"
    if s.startswith("Y"):
        return "https://www.airservicesaustralia.com/naips/", "NAIPS Australia"
    if s.startswith("NZ"):
        return "https://aip.airways.co.nz/", "Airways NZ"
    return "https://www.icao.int/safety/airnavigation/NOTAM/", "ICAO NOTAM"


@app.route("/api/aviation")
@limiter.limit("20 per minute")
def api_aviation():  # noqa: C901
    station = request.args.get("station", "").strip().upper()
    if not _valid_station(station):
        return jsonify({"error": "valid ICAO station code required (3-4 alphanumeric)"}), 400

    result = {
        "station": station,
        "metar": [],
        "metar_decoded": None,
        "taf": [],
        "airsigmet": [],
        "pireps": [],
        "notams": [],
    }

    # METAR
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/metar",
            params={"ids": station, "format": "json", "hours": 6},
            timeout=10,
        )
        r.raise_for_status()
        metars = r.json() or []
        result["metar"] = metars
        if metars:
            result["metar_decoded"] = decode_metar(metars[0])
    except requests.RequestException:
        logger.warning("METAR fetch failed for %s", station)

    # TAF
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/taf",
            params={"ids": station, "format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        result["taf"] = r.json() or []
    except requests.RequestException:
        logger.warning("TAF fetch failed for %s", station)

    # SIGMET/AIRMET
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/airsigmet",
            params={"format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        all_alerts = r.json() or []
        if result["metar_decoded"] and result["metar_decoded"].get("lat"):
            slat = result["metar_decoded"]["lat"]
            slon = result["metar_decoded"]["lon"]
            nearby = []
            for a in all_alerts:
                for coord in a.get("coords", []):
                    if abs(coord.get("lat", 0) - slat) < 5 and abs(coord.get("lon", 0) - slon) < 8:
                        nearby.append(a)
                        break
            result["airsigmet"] = nearby
        else:
            result["airsigmet"] = all_alerts[:20]
    except requests.RequestException:
        logger.warning("SIGMET fetch failed for %s", station)

    # PIREPs
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/pirep",
            params={"id": station, "format": "json", "distance": 100, "age": 3},
            timeout=10,
        )
        r.raise_for_status()
        result["pireps"] = (r.json() or [])[:20]
    except requests.RequestException:
        logger.warning("PIREP fetch failed for %s", station)

    # NOTAMs — NAV CANADA for CY** airports
    result["notam_source"] = None
    if station.startswith("C"):
        try:
            r = _session.get(
                "https://plan.navcanada.ca/weather/api/alpha/",
                params={"site": station, "alpha": "notam"},
                headers={"User-Agent": "UAVChum/1.0"},
                timeout=15,
            )
            r.raise_for_status()
            notams = []
            for item in r.json().get("data", []):
                if item.get("type") != "notam":
                    continue
                try:
                    raw = json.loads(item.get("text", "{}")).get("raw", "")
                except (ValueError, AttributeError):
                    raw = item.get("text", "")
                if raw:
                    notams.append({"raw": raw, "source": "NAV CANADA"})
            result["notams"] = notams[:60]
            result["notam_source"] = "NAV CANADA"
        except requests.RequestException:
            logger.warning("NAV CANADA NOTAM fetch failed for %s", station)

    # Primary international: ANB Data (free, no auth, global ICAO coverage)
    if not result["notams"]:
        try:
            r = _session.get(
                "https://api.anbdata.com/anb/states/notams/notams-list",
                params={"client_id": "test", "icao_location": station},
                headers={"User-Agent": "UAVChum/1.0"},
                timeout=10,
            )
            r.raise_for_status()
            for n in r.json() or []:
                # ANB returns the entire country dataset regardless of the requested
                # station — filter to only NOTAMs whose location matches this station.
                if n.get("location", "").upper() != station:
                    continue
                raw = n.get("all") or n.get("message") or ""
                if raw:
                    result["notams"].append({"raw": raw, "source": "ANB"})
            if result["notams"]:
                result["notam_source"] = "ANB"
        except requests.RequestException:
            logger.warning("ANB NOTAM fetch failed for %s", station)

    # Fallback: pull any SIGMETs mentioning the station from the XML dataserver
    if not result["notams"]:
        try:
            r = _session.get(
                "https://aviationweather.gov/api/data/dataserver",
                params={
                    "requestType": "retrieve",
                    "dataSource": "airsigmets",
                    "stationString": station,
                    "hoursBeforeNow": "24",
                    "format": "xml",
                },
                timeout=10,
            )
            r.raise_for_status()
            # Guard against excessively large responses
            if len(r.text) < 500_000:
                root = ET.fromstring(r.text)
                for elem in root.iter("AIRSIGMET"):
                    raw = elem.findtext("raw_text", "")
                    if raw and station in raw:
                        result["notams"].append({"raw": raw, "source": "AWC SIGMET/AIRMET"})
        except (requests.RequestException, ET.ParseError):
            logger.warning("NOTAM XML fallback failed for %s", station)

    if not result["notams"]:
        portal_url, portal_label = _notam_portal(station)
        result["notam_source"] = "unavailable"
        result["notam_portal_url"] = portal_url
        result["notam_portal_label"] = portal_label
        result["notams_note"] = (
            f"No keyless NOTAM API is available for this region. "
            f"View live NOTAMs at {portal_label}."
        )

    return jsonify(result)


@app.route("/api/airspace")
@limiter.limit("20 per minute")
def api_airspace():  # noqa: C901
    """Return NFZ/airspace data — FAA ArcGIS (no key) + TFRs + nearby airports."""
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    if lat is None or lon is None or not _valid_lat(lat) or not _valid_lon(lon):
        return jsonify({"error": "valid lat/lon required"}), 400

    delta = 1.5  # ~165 km box
    bbox_env = f"{lon - delta},{lat - delta},{lon + delta},{lat + delta}"
    result: dict = {"airspace": [], "tfrs": [], "uasfm": [], "airports": []}

    # FAA Controlled Airspace Class B / C / D
    try:
        r = _session.get(
            "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
            "/Class_Airspace/FeatureServer/0/query",
            params={
                "where": "CLASS IN ('B','C','D')",
                "geometry": bbox_env,
                "geometryType": "esriGeometryEnvelope",
                "spatialRel": "esriSpatialRelIntersects",
                "outFields": (
                    "CLASS,NAME,IDENT,LOWER_VAL,UPPER_VAL,LOWER_UOM,UPPER_UOM,LOWER_CODE,UPPER_CODE"
                ),
                "f": "geojson",
                "resultRecordCount": 100,
            },
            timeout=10,
        )
        if r.status_code == 200:
            for feat in r.json().get("features", []):
                cls = feat.get("properties", {}).get("CLASS", "")
                feat["properties"]["_class"] = cls
                result["airspace"].append(feat)
    except requests.RequestException:
        logger.warning("FAA class airspace fetch failed lat=%s lon=%s", lat, lon)

    # FAA UAS Facility Map (LAANC)
    try:
        r = _session.get(
            "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
            "/FAA_UAS_FacilityMap_Data_Primary/FeatureServer/0/query",
            params={
                "where": "1=1",
                "geometry": bbox_env,
                "geometryType": "esriGeometryEnvelope",
                "spatialRel": "esriSpatialRelIntersects",
                "outFields": "CEILING,UNIT,APT1_ICAO,APT1_NAME,AIRSPACE_1",
                "f": "geojson",
                "resultRecordCount": 200,
            },
            timeout=10,
        )
        if r.status_code == 200:
            result["uasfm"] = r.json().get("features", [])
    except requests.RequestException:
        logger.warning("FAA UASFM fetch failed lat=%s lon=%s", lat, lon)

    # TFRs
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/tfr",
            params={"format": "json"},
            timeout=8,
        )
        if r.status_code == 200:
            nearby = []
            for t in r.json() or []:
                tlat = t.get("lat") or t.get("latitude")
                tlon = t.get("lon") or t.get("longitude")
                if tlat and tlon:
                    try:
                        if (
                            abs(float(tlat) - lat) < delta + 0.5
                            and abs(float(tlon) - lon) < delta + 0.5
                        ):
                            nearby.append(t)
                    except (TypeError, ValueError):
                        nearby.append(t)
                else:
                    nearby.append(t)
            result["tfrs"] = nearby[:20]
    except requests.RequestException:
        logger.warning("TFR fetch failed lat=%s lon=%s", lat, lon)

    # Nearby airports via METAR bbox
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/metar",
            params={
                "bbox": f"{lat - delta},{lon - delta},{lat + delta},{lon + delta}",
                "format": "json",
                "hours": 2,
            },
            timeout=10,
        )
        if r.status_code == 200:
            seen: set = set()
            airports = []
            for m in r.json() or []:
                icao = m.get("icaoId", "")
                if not icao or icao in seen or not m.get("lat") or not m.get("lon"):
                    continue
                seen.add(icao)
                dm = decode_metar(m)
                airports.append(
                    {
                        "icao": icao,
                        "name": m.get("name", icao),
                        "lat": m.get("lat"),
                        "lon": m.get("lon"),
                        "elev": dm.get("elevation_ft"),
                        "flight_cat": dm.get("flight_cat"),
                        "wind_dir": dm.get("wind_dir"),
                        "wind_speed_kt": dm.get("wind_speed_kt"),
                        "wind_gust_kt": dm.get("wind_gust_kt"),
                        "visibility": dm.get("visibility"),
                        "temp_c": dm.get("temp_c"),
                        "clouds": dm.get("clouds"),
                        "wx_string": dm.get("wx_string"),
                        "raw": dm.get("raw"),
                        "time": dm.get("time"),
                    }
                )
            result["airports"] = airports[:40]
    except requests.RequestException:
        logger.warning("Airport METAR fetch failed lat=%s lon=%s", lat, lon)

    # OpenAIP — infer country from coordinates if not supplied (handles bookmarks / old URLs)
    country = request.args.get("country", "").strip().upper()
    if not country or not _valid_country(country):
        country = _country_from_latlon(round(lat), round(lon))
    openaip_was_cached = False
    openaip_ts = None
    if country and _valid_country(country):
        odata, openaip_was_cached, openaip_ts = fetch_openaip(country)
        result["openaip"] = filter_openaip(odata, lat, lon, delta)
    else:
        result["openaip"] = []

    now_ts = int(time.time())
    result["sources"] = [
        {
            "name": "FAA Controlled Airspace",
            "type": "Class B / C / D",
            "features": len(result["airspace"]),
            "live": True,
            "ts": now_ts,
        },
        {
            "name": "FAA UAS Facility Map",
            "type": "LAANC drone altitude grids",
            "features": len(result["uasfm"]),
            "live": True,
            "ts": now_ts,
        },
        {
            "name": "aviationweather.gov",
            "type": f"TFRs ({len(result['tfrs'])}) & airports ({len(result['airports'])})",
            "features": len(result["tfrs"]) + len(result["airports"]),
            "live": True,
            "ts": now_ts,
        },
    ]
    if country and _valid_country(country):
        result["sources"].append(
            {
                "name": "OpenAIP",
                "type": f"Airspace data ({country})",
                "features": len(result["openaip"]),
                "live": not openaip_was_cached,
                "ts": openaip_ts,
            }
        )

    return jsonify(result)


@app.route("/api/station")
@limiter.limit("60 per minute")
def api_station():
    """Get station/airport info."""
    station = request.args.get("id", "").strip().upper()
    if not _valid_station(station):
        return jsonify({"error": "valid ICAO station code required"}), 400
    try:
        r = _session.get(
            "https://aviationweather.gov/api/data/airport",
            params={"ids": station, "format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        return jsonify(data[0] if data else {})
    except requests.RequestException:
        logger.exception("Station lookup failed for %s", station)
        return jsonify({"error": "Station data unavailable"}), 502


@app.route("/api/flightroute")
@limiter.limit("30 per minute")
def api_flightroute():
    """Proxy adsbdb.com callsign lookup — returns origin/destination/airline."""
    callsign = request.args.get("callsign", "").strip().upper()
    if not callsign or not fullmatch(r"[A-Z0-9]{3,8}", callsign):
        return jsonify({"error": "valid callsign required"}), 400
    try:
        r = _session.get(
            f"https://api.adsbdb.com/v0/callsign/{callsign}",
            headers={"User-Agent": "UAVChum/1.0"},
            timeout=8,
        )
        r.raise_for_status()
        data = r.json()
        route = data.get("response", {}).get("flightroute") or {}
        if not route:
            return jsonify({"found": False})
        return jsonify(
            {
                "found": True,
                "callsign_iata": route.get("callsign_iata", ""),
                "airline": (route.get("airline") or {}).get("name", ""),
                "origin": _format_airport(route.get("origin")),
                "destination": _format_airport(route.get("destination")),
            }
        )
    except requests.RequestException:
        logger.warning("flightroute lookup failed for %s", callsign)
        return jsonify({"found": False})


def _format_airport(ap: dict | None) -> dict:
    if not ap:
        return {}
    return {
        "iata": ap.get("iata_code", ""),
        "icao": ap.get("icao_code", ""),
        "name": ap.get("name", ""),
        "municipality": ap.get("municipality", ""),
        "country": ap.get("country_name", ""),
    }


@app.route("/api/adsb")
# Community ADS-B feeds — no auth, no rate limit issues.
# Primary: adsb.lol (ODbL). Fallbacks: airplanes.live, opendata.adsb.fi.
@limiter.limit("100 per minute")
def api_adsb():
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    if lat is None or lon is None or not _valid_lat(lat) or not _valid_lon(lon):
        return jsonify({"error": "valid lat/lon required"}), 400
    radius_nm = 150
    rlat, rlon = round(lat, 4), round(lon, 4)
    apis = [
        f"https://api.adsb.lol/v2/lat/{rlat}/lon/{rlon}/dist/{radius_nm}",
        f"https://api.airplanes.live/v2/point/{rlat}/{rlon}/{radius_nm}",
        f"https://opendata.adsb.fi/api/v3/lat/{rlat}/lon/{rlon}/dist/{radius_nm}",
    ]
    _ua = {"User-Agent": "UAVChum/1.0 (uavchum.app)"}
    data = None
    for url in apis:
        try:
            r = _session.get(url, headers=_ua, timeout=8)
            r.raise_for_status()
            data = r.json()
            break
        except requests.RequestException as exc:
            logger.warning("ADS-B source failed %s: %s", url, exc)
    if data is None:
        return jsonify({"aircraft": [], "count": 0}), 200

    aircraft = []
    for ac in data.get("ac") or []:
        if ac.get("lat") is None or ac.get("lon") is None:
            continue
        # alt_baro is in feet; frontend expects alt_m in metres
        alt_baro = ac.get("alt_baro")
        alt_m = round(alt_baro / 3.28084, 1) if isinstance(alt_baro, (int, float)) else None
        # gs is in knots; frontend expects velocity_ms in m/s
        gs = ac.get("gs")
        velocity_ms = round(gs * 0.514444, 1) if isinstance(gs, (int, float)) else None
        aircraft.append(
            {
                "icao24": ac.get("hex", ""),
                "callsign": (ac.get("flight") or "").strip(),
                "lat": ac["lat"],
                "lon": ac["lon"],
                "alt_m": alt_m,
                "on_ground": ac.get("alt_baro") == "ground",
                "velocity_ms": velocity_ms,
                "heading": ac.get("track"),
                "registration": (ac.get("r") or "").strip(),
                "ac_type": (ac.get("t") or "").strip(),
                "squawk": (ac.get("squawk") or "").strip(),
                "baro_rate": ac.get("baro_rate"),
            }
        )
    return jsonify({"aircraft": aircraft, "count": len(aircraft)})


# ── Lightning / Blitzortung ──────────────────────────────────────────────────
_strikes: deque = deque(maxlen=100_000)
_strikes_lock = threading.Lock()
_blitzortung_connected = False
_STRIKE_MAX_AGE = 30 * 60  # seconds

_BLITZORTUNG_URLS = [
    "wss://ws1.blitzortung.org:3000/",
    "wss://ws5.blitzortung.org:3000/",
    "wss://ws7.blitzortung.org:3000/",
]


_EARTH_NM = 3440.065


def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return _EARTH_NM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _blitzortung_thread():  # noqa: C901
    """Daemon thread: subscribe to Blitzortung WebSocket and buffer strikes."""
    global _blitzortung_connected
    try:
        import websocket as _websocket_mod  # websocket-client package

        if not hasattr(_websocket_mod, "WebSocketApp"):
            logger.warning(
                "websocket-client is not installed (found a different 'websocket' module). "
                "Run: pip install websocket-client  Lightning strikes disabled."
            )
            return
    except ImportError:
        logger.warning("websocket-client not installed. Lightning strikes disabled.")
        return

    import websocket  # noqa: PLC0415  re-import under canonical name for readability

    url_idx = 0
    reconnect_delay = 5
    while True:
        url = _BLITZORTUNG_URLS[url_idx % len(_BLITZORTUNG_URLS)]
        did_connect = False

        def on_message(_ws, message):
            try:
                d = json.loads(message)
                lat = d.get("lat")
                lon = d.get("lon")
                ts_ns = d.get("time")
                if lat is None or lon is None or ts_ns is None:
                    return
                with _strikes_lock:
                    _strikes.append((float(lat), float(lon), ts_ns / 1_000_000_000))
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        def on_open(_ws, _url=url):
            nonlocal did_connect
            global _blitzortung_connected
            did_connect = True
            _blitzortung_connected = True
            logger.info("Blitzortung connected: %s", _url)

        def on_close(_ws, _code, _msg):
            global _blitzortung_connected
            _blitzortung_connected = False
            logger.warning("Blitzortung disconnected")

        def on_error(_ws, error):
            global _blitzortung_connected
            _blitzortung_connected = False
            logger.warning("Blitzortung error: %s", error)

        try:
            ws = websocket.WebSocketApp(
                url,
                on_message=on_message,
                on_open=on_open,
                on_close=on_close,
                on_error=on_error,
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except (OSError, AttributeError) as exc:
            logger.warning("Blitzortung thread exception: %s", exc)
            _blitzortung_connected = False

        if did_connect:
            reconnect_delay = 5  # successful session — reset backoff
        else:
            reconnect_delay = min(reconnect_delay * 2, 120)  # exponential backoff up to 2 min

        url_idx += 1
        time.sleep(reconnect_delay)


threading.Thread(target=_blitzortung_thread, daemon=True, name="blitzortung").start()


@app.route("/api/lightning")
@limiter.limit("60 per minute")
def api_lightning():
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    radius_nm = request.args.get("radius_nm", default=150, type=float)
    if not _valid_lat(lat) or not _valid_lon(lon):
        return jsonify({"error": "valid lat/lon required"}), 400
    radius_nm = min(max(radius_nm, 10), 300)
    cutoff = time.time() - _STRIKE_MAX_AGE
    now = time.time()

    with _strikes_lock:
        snapshot = list(_strikes)

    nearby = []
    nearest_nm = None
    for s_lat, s_lon, s_ts in snapshot:
        if s_ts < cutoff:
            continue
        d = _haversine_nm(lat, lon, s_lat, s_lon)
        if d <= radius_nm:
            age_s = int(now - s_ts)
            nearby.append({"lat": round(s_lat, 4), "lon": round(s_lon, 4), "age_s": age_s})
            if nearest_nm is None or d < nearest_nm:
                nearest_nm = round(d, 1)

    nearby.sort(key=lambda x: x["age_s"])
    return jsonify(
        {
            "strikes": nearby[:500],
            "count": len(nearby),
            "nearest_nm": nearest_nm,
            "connected": _blitzortung_connected,
        }
    )


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug, port=5555)
