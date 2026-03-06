const $ = s => document.querySelector(s);

const L = window.L;

// ── Global state ────────────────────────────────────────────────
let currentElevation = null;
let currentWxData    = null;
let _adsbTimer       = null;
let _lightningTimer  = null;

const units = {
    wind: localStorage.getItem('windUnit') || 'kn',
    temp: localStorage.getItem('tempUnit') || 'C',
};
let droneClass = localStorage.getItem('droneClass') || 'consumer';

function toWind(kn) {
    if (kn == null) return '—';
    return units.wind === 'kn' ? Math.round(kn) : Math.round(kn * 1.852);
}
function windUnit() { return units.wind === 'kn' ? 'kn' : 'km/h'; }
function toTemp(c) {
    if (c == null) return '—';
    return units.temp === 'C' ? Math.round(c) : Math.round(c * 9 / 5 + 32);
}
function tempUnit() { return units.temp === 'C' ? '°C' : '°F'; }

/* ── Drone assessment ──────────────────────────────────────────── */
const DRONE_THRESHOLDS = {
    mini:     { windCaution: 20, windDanger: 30, gustCaution: 25, gustDanger: 38 },
    consumer: { windCaution: 20, windDanger: 35, gustCaution: 30, gustDanger: 45 },
    pro:      { windCaution: 30, windDanger: 50, gustCaution: 40, gustDanger: 65 },
};

function assessDrone(wx, cls) {
    const c   = wx.current;
    const thr = DRONE_THRESHOLDS[cls] || DRONE_THRESHOLDS.consumer;
    const factors = [];

    const ws_kmh = (c.wind_speed || 0) * 1.852;
    const wg_kmh = (c.wind_gusts || 0) * 1.852;

    if (ws_kmh <= thr.windCaution)
        factors.push({ name:'Wind', value:`${Math.round(ws_kmh)} km/h (${Math.round(c.wind_speed||0)} kn)`, status:'good', note:'Light winds — safe for most drones' });
    else if (ws_kmh <= thr.windDanger)
        factors.push({ name:'Wind', value:`${Math.round(ws_kmh)} km/h (${Math.round(c.wind_speed||0)} kn)`, status:'caution', note:'Moderate winds — small drones will struggle' });
    else
        factors.push({ name:'Wind', value:`${Math.round(ws_kmh)} km/h (${Math.round(c.wind_speed||0)} kn)`, status:'danger', note:'Strong winds — unsafe for most consumer drones' });

    if (wg_kmh <= thr.gustCaution)
        factors.push({ name:'Gusts', value:`${Math.round(wg_kmh)} km/h (${Math.round(c.wind_gusts||0)} kn)`, status:'good', note:'Gusts within safe limits' });
    else if (wg_kmh <= thr.gustDanger)
        factors.push({ name:'Gusts', value:`${Math.round(wg_kmh)} km/h (${Math.round(c.wind_gusts||0)} kn)`, status:'caution', note:'Gusty — expect instability and drift' });
    else
        factors.push({ name:'Gusts', value:`${Math.round(wg_kmh)} km/h (${Math.round(c.wind_gusts||0)} kn)`, status:'danger', note:'Severe gusts — do not fly' });

    // Gust ratio — catches calm-wind-but-spiky conditions
    const gustRatio = ws_kmh > 5 ? wg_kmh / ws_kmh : 0;
    if (gustRatio >= 3.0)
        factors.push({ name:'Gust Variability', value:`${gustRatio.toFixed(1)}× ratio`, status:'danger',  note:'Extreme gust variability — sudden speed spikes, do not fly' });
    else if (gustRatio >= 2.0)
        factors.push({ name:'Gust Variability', value:`${gustRatio.toFixed(1)}× ratio`, status:'caution', note:'High gust variability — expect sudden, unpredictable speed changes' });

    // Low-level wind shear (80 m vs 10 m)
    const wind80m = wx.hourly?.[0]?.wind_80m;
    if (wind80m != null) {
        const diff_kn  = wind80m - (c.wind_speed || 0);
        const diff_kmh = diff_kn * 1.852;
        const w80_kmh  = Math.round(wind80m * 1.852);
        if (diff_kn >= 20)
            factors.push({ name:'Wind Shear', value:`${w80_kmh} km/h at 80 m`, status:'danger',  note:`Severe low-level wind shear (+${Math.round(diff_kmh)} km/h above 10 m) — altitude changes will be violent` });
        else if (diff_kn >= 10)
            factors.push({ name:'Wind Shear', value:`${w80_kmh} km/h at 80 m`, status:'caution', note:`Low-level wind shear (+${Math.round(diff_kmh)} km/h above 10 m) — expect turbulence on ascent/descent` });
    }

    const precip = c.precip || 0, group = c.group || 'clear';
    if (precip === 0 && !['rain','snow','storm'].includes(group))
        factors.push({ name:'Precipitation', value:'None', status:'good', note:'Dry conditions' });
    else if (precip < 1 && group !== 'storm')
        factors.push({ name:'Precipitation', value:`${precip} mm`, status:'caution', note:'Light precipitation — most drones are not waterproof' });
    else
        factors.push({ name:'Precipitation', value: precip ? `${precip} mm` : group, status:'danger', note:'Active precipitation — risk of water damage' });

    const cloud = c.cloud_cover || 0;
    if (cloud <= 50)       factors.push({ name:'Cloud Cover', value:`${cloud}%`, status:'good',    note:'Good visual conditions' });
    else if (cloud <= 80)  factors.push({ name:'Cloud Cover', value:`${cloud}%`, status:'caution', note:'Overcast — maintain visual line of sight' });
    else                   factors.push({ name:'Cloud Cover', value:`${cloud}%`, status:'caution', note:'Heavy overcast — limited contrast, harder to spot drone' });

    const temp = c.temp || 0;
    if (temp >= 5 && temp <= 40)
        factors.push({ name:'Temperature', value:`${Math.round(temp)}°C`, status:'good',    note:'Within normal operating range' });
    else if ((temp >= 0 && temp < 5) || (temp > 40 && temp <= 45))
        factors.push({ name:'Temperature', value:`${Math.round(temp)}°C`, status:'caution', note:'Battery performance may be reduced' });
    else
        factors.push({ name:'Temperature', value:`${Math.round(temp)}°C`, status:'danger',
            note: temp < 0 ? 'Extreme cold — battery failure risk, LiPo danger zone' : 'Extreme heat — risk of overheating' });

    if (group === 'storm')
        factors.push({ name:'Severe Weather', value: c.desc || 'Thunderstorm', status:'danger', note:'Thunderstorms — do NOT fly' });
    else if (group === 'fog')
        factors.push({ name:'Visibility', value:'Fog', status:'danger', note:'Fog — cannot maintain visual line of sight' });

    // Radiation fog risk
    if ([0,1].includes(c.weather_code || 0) && (c.humidity||0) > 88 && ws_kmh < 9 && c.is_day === 0)
        factors.push({ name:'Fog Risk', value:'Possible', status:'caution',
            note:'Clear sky + high humidity + calm winds at night → radiation fog likely by morning' });

    // Density altitude — use search elevation or Open-Meteo site elevation
    const elev_m = currentElevation ?? wx.elevation ?? null;
    if (elev_m != null) {
        const pa_ft = (1013.25 - (c.pressure || 1013.25)) * 27 + (elev_m * 3.28084);
        const isa   = 15 - (elev_m / 1000 * 6.5);
        const da_ft = pa_ft + 120 * ((c.temp || 15) - isa);
        const daVal = `${Math.round(da_ft).toLocaleString()} ft`;
        if (da_ft < 3000)
            factors.push({ name:'Density Altitude', value:daVal, status:'good',    note:'Normal air density — full thrust available' });
        else if (da_ft < 6000)
            factors.push({ name:'Density Altitude', value:daVal, status:'caution', note:'Reduced air density — drone may underperform' });
        else
            factors.push({ name:'Density Altitude', value:daVal, status:'danger',  note:'Very high density altitude — significant thrust loss expected' });
    }

    // Hourly verdicts
    const hourlyVerdicts = (wx.hourly || []).map(h => {
        const hw = (h.wind||0) * 1.852, hg = (h.gusts||0) * 1.852;
        const hgroup = h.group || 'clear', hp = h.precip_prob || 0;
        const block  = hw > thr.windDanger || hg > thr.gustDanger || ['storm','fog'].includes(hgroup);
        const issues = [hw > thr.windCaution, hg > thr.gustCaution,
                        ['rain','snow'].includes(hgroup), hp > 60].filter(Boolean).length;
        return { time: h.time, status: block ? 'danger' : issues >= 2 ? 'caution' : 'good' };
    });

    const statuses = factors.map(f => f.status);
    let verdict, color, summary;
    if (statuses.includes('danger'))
        { verdict='NO-GO';    color='red';   summary='Conditions are unsafe for drone flight'; }
    else if (statuses.filter(s=>s==='caution').length >= 2)
        { verdict='MARGINAL'; color='amber'; summary='Fly with caution — multiple limiting factors'; }
    else if (statuses.includes('caution'))
        { verdict='MARGINAL'; color='amber'; summary='Mostly OK but check limiting factors'; }
    else
        { verdict='GO';       color='green'; summary='Conditions are good for drone flight'; }

    return { verdict, color, summary, factors, hourly: hourlyVerdicts };
}

function assessDayFlyability(f, cls) {
    const thr = DRONE_THRESHOLDS[cls] || DRONE_THRESHOLDS.consumer;
    let dangers = 0, cautions = 0;
    const reasons = [];

    const ws_kmh = (f.wind_max || 0) * 1.852;
    const wg_kmh = (f.gusts_max || 0) * 1.852;

    if (ws_kmh > thr.windDanger)        { dangers++;  reasons.push(`Wind ${Math.round(ws_kmh)} km/h — too strong`); }
    else if (ws_kmh > thr.windCaution)  { cautions++; reasons.push(`Wind ${Math.round(ws_kmh)} km/h — moderate`); }

    if (wg_kmh > thr.gustDanger)        { dangers++;  reasons.push(`Gusts ${Math.round(wg_kmh)} km/h — severe`); }
    else if (wg_kmh > thr.gustCaution)  { cautions++; reasons.push(`Gusts ${Math.round(wg_kmh)} km/h — gusty`); }

    const gustRatio = ws_kmh > 5 ? wg_kmh / ws_kmh : 0;
    if (gustRatio >= 3.0)      { dangers++;  reasons.push(`Extreme gust variability (${gustRatio.toFixed(1)}×)`); }
    else if (gustRatio >= 2.0) { cautions++; reasons.push(`High gust variability (${gustRatio.toFixed(1)}×)`); }

    const group = (f.group || '').toLowerCase();
    if (['storm', 'fog'].some(g => group.includes(g)))       { dangers++;  reasons.push(`${f.group} — hazardous`); }
    else if (['rain', 'snow', 'drizzle'].some(g => group.includes(g))) { cautions++; reasons.push(`${f.group} — precipitation risk`); }

    if ((f.precip_prob || 0) > 60) { cautions++; reasons.push(`${f.precip_prob}% precip chance`); }

    let verdict, cls2;
    if (dangers > 0)   { verdict = 'NO-GO';    cls2 = 'no-go';    }
    else if (cautions) { verdict = 'MARGINAL'; cls2 = 'marginal'; }
    else               { verdict = 'GO';       cls2 = 'go';       }

    const tip = reasons.length ? reasons.join(' · ') : 'Conditions look good';
    return { verdict, cls: cls2, tip };
}

let currentLat = null, currentLon = null, currentCountry = '', currentCountryName = '';
let droneMap = null, droneLayerGroups = {};
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__uavchumDebug = { get currentLat() { return currentLat; }, get currentLon() { return currentLon; },
        get currentCountry() { return currentCountry; }, get currentCountryName() { return currentCountryName; },
        get droneMap() { return droneMap; }, get droneLayerGroups() { return droneLayerGroups; },
        get adsbTimer() { return _adsbTimer; } };
}

/* ── Theme toggle ──────────────────────────────────────────────── */
(function setupTheme() {
    const html = document.documentElement;
    const btn  = document.getElementById('themeToggle');
    if (localStorage.getItem('theme') === 'light') html.setAttribute('data-theme', 'light');
    btn.addEventListener('click', () => {
        const isLight = html.getAttribute('data-theme') === 'light';
        if (isLight) {
            html.removeAttribute('data-theme');
            localStorage.setItem('theme', 'dark');
        } else {
            html.setAttribute('data-theme', 'light');
            localStorage.setItem('theme', 'light');
        }
    });
})();

/* helpers */
function flag(cc) {
    if (!cc || cc.length !== 2) return '';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

// Allowlist helpers — prevent class-attribute injection
const _ICON_RE    = /^wi-[\w-]+$/;
const _STATUS_OK  = new Set(['good', 'caution', 'danger']);
const _FC_OK      = new Set(['VFR', 'MVFR', 'IFR', 'LIFR']);
const _FC_TOOLTIP  = { VFR: 'VFR — Visual Flight Rules: ceiling >3000 ft & visibility >5 SM. Good conditions.', MVFR: 'MVFR — Marginal VFR: ceiling 1000–3000 ft or visibility 3–5 SM. Caution advised.', IFR: 'IFR — Instrument Flight Rules: ceiling 500–999 ft or visibility 1–3 SM. Poor conditions.', LIFR: 'LIFR — Low IFR: ceiling <500 ft or visibility <1 SM. Very poor conditions.' };

function safeIcon(s)   { return typeof s === 'string' && _ICON_RE.test(s) ? s : 'wi-na'; }
function safeStatus(s) { return _STATUS_OK.has(s) ? s : 'good'; }
function safeFC(s)     { return _FC_OK.has(s) ? s : ''; }

function distKm(a, b, c, d) {
    const R = 6371, dlat = (c - a) * Math.PI / 180, dlon = (d - b) * Math.PI / 180;
    const x = Math.sin(dlat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dlon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const distNm = (a, b, c, d) => distKm(a, b, c, d) * 0.539957;

/* ── Search ────────────────────────────────────────────────────── */
(function setupSearch() {
    const input   = $('#locationSearch');
    const results = $('#searchResults');
    let timer;

    input.addEventListener('input', e => {
        clearTimeout(timer);
        const q = e.target.value.trim();
        if (q.length < 2) { results.classList.add('hidden'); return; }
        timer = setTimeout(() => doSearch(q), 280);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') results.classList.add('hidden');
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-box')) results.classList.add('hidden');
    });

    async function doSearch(q) {
        try {
            const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
            results.replaceChildren();
            if (!data.length || data.error) {
                const empty = document.createElement('div');
                empty.className = 'sr-item sr-empty';
                empty.textContent = 'No results';
                results.appendChild(empty);
            } else {
                data.forEach(l => {
                    const item = document.createElement('div');
                    item.className = 'sr-item';
                    item.dataset.lat = Number(l.lat);
                    item.dataset.lon = Number(l.lon);
                    item.dataset.name = `${l.name}, ${l.admin1 || l.country}`.replace(/[\r\n]+/g, ' ').trim();
                    item.dataset.country = l.country_code || '';
                    item.dataset.countryName = (l.country || '').replace(/[\r\n]+/g, ' ').trim();
                    item.dataset.elev = l.elevation != null ? Number(l.elevation) : '';

                    const flagEl = document.createElement('span');
                    flagEl.className = 'sr-flag';
                    flagEl.textContent = flag(l.country_code);

                    const text = document.createElement('div');
                    text.className = 'sr-text';

                    const nameEl = document.createElement('div');
                    nameEl.className = 'name';
                    nameEl.textContent = l.name || '';

                    const region = document.createElement('div');
                    region.className = 'region';
                    const regionParts = [l.admin1, l.country].filter(Boolean).join(', ');
                    const popSuffix = l.population ? ` · ${Number(l.population).toLocaleString()}` : '';
                    region.textContent = `${regionParts}${popSuffix}`;

                    text.appendChild(nameEl);
                    text.appendChild(region);

                    item.appendChild(flagEl);
                    item.appendChild(text);

                    item.addEventListener('click', () => {
                        input.value = item.dataset.name;
                        results.classList.add('hidden');
                        loadLocation(
                            item.dataset.lat,
                            item.dataset.lon,
                            item.dataset.name,
                            item.dataset.country,
                            item.dataset.elev || null,
                            item.dataset.countryName || ''
                        );
                    });

                    results.appendChild(item);
                });
            }
            results.classList.remove('hidden');
        } catch (e) { console.error('search error', e); }
    }
})();

/* ── Page load restore ─────────────────────────────────────────── */
(function restoreOnLoad() {
    const p = new URLSearchParams(window.location.search);
    if (p.has('lat') && p.has('lon')) {
        loadLocation(
            p.get('lat'), p.get('lon'),
            p.get('name') || 'Saved location',
            p.get('cc') || '',
            p.get('elev') || null,
            p.get('cn') || ''
        );
        return;
    }
    const saved = localStorage.getItem('lastLocation');
    if (!saved) return;
    try {
        const l = JSON.parse(saved);
        if (l.lat && l.lon) {
            loadLocation(
                l.lat,
                l.lon,
                l.name || 'Last location',
                l.country || '',
                l.elev ?? null,
                l.countryName || ''
            );
        }
    } catch {}
})();

/* ── Main load ─────────────────────────────────────────────────── */
async function loadLocation(lat, lon, name, country, elev, countryName) {
    currentLat       = parseFloat(lat);
    currentLon       = parseFloat(lon);
    currentCountry   = (country || '').toUpperCase();
    currentCountryName = (countryName || '').trim();
    currentElevation = (elev != null && elev !== '') ? parseFloat(elev) : null;

    if (_adsbTimer)      { clearInterval(_adsbTimer);      _adsbTimer      = null; }
    if (_lightningTimer) { clearInterval(_lightningTimer); _lightningTimer = null; }

    // URL state
    const url = new URL(window.location);
    url.searchParams.set('lat', currentLat);
    url.searchParams.set('lon', currentLon);
    url.searchParams.set('name', name || '');
    if (currentCountry && /^[A-Z]{2}$/.test(currentCountry)) url.searchParams.set('cc', currentCountry);
    else url.searchParams.delete('cc');
    if (currentCountryName) url.searchParams.set('cn', currentCountryName);
    else url.searchParams.delete('cn');
    if (currentElevation != null) url.searchParams.set('elev', currentElevation);
    else url.searchParams.delete('elev');
    history.pushState({}, '', url);

    // Persist last location
    localStorage.setItem('lastLocation', JSON.stringify({
        lat: currentLat, lon: currentLon,
        name: name || '',
        country: currentCountry,
        countryName: currentCountryName,
        elev: currentElevation,
    }));

    $('#mainPrompt').classList.add('hidden');
    $('#mainError').classList.add('hidden');
    $('#mainLoading').classList.remove('hidden');
    $('#mainContent').classList.add('hidden');
    $('#nfzSummary').classList.add('hidden');
    $('#nfzLoading').classList.add('hidden');
    $('#layerToggles').classList.add('hidden');
    $('#airportsCard').classList.add('hidden');
    $('#sourcesCard').classList.add('hidden');

    const airspaceUrl  = `/api/airspace?lat=${lat}&lon=${lon}${currentCountry ? '&country=' + encodeURIComponent(currentCountry) : ''}`;
    const wxPromise    = fetch(`/api/weather?lat=${lat}&lon=${lon}`).then(r => r.json()).catch(() => null);
    const asPromise    = fetch(airspaceUrl).then(r => r.json()).catch(() => ({}));

    try {
        const wx = await wxPromise;
        if (!wx || wx.error) throw new Error(wx?.error || 'Weather unavailable');

        currentWxData = wx;
        const dr = assessDrone(wx, droneClass);
        renderHero(wx, dr, name);
        renderHourly(wx.hourly, dr.hourly);
        renderForecast(wx.forecast);
        renderDaylight(wx.forecast, wx.timezone);
        renderDroneFactors(dr.factors);
        renderChecklist();

        $('#mainContent').classList.remove('hidden');
        setTimeout(() => setupDroneMap(currentLat, currentLon, name), 20);

        $('#nfzLoading').classList.remove('hidden');
        const as = await asPromise;
        renderAirspaceOnMap(as);
        renderAirports(as.airports || []);
        updateVisibilityCeiling(as.airports || []);
        renderSources(as.sources);
        startAdsbRefresh();
        startLightningRefresh();

        // Auto-load aviation briefing for nearest airport
        const nearestAirport = (as.airports || [])
            .filter(ap => ap.lat && ap.lon)
            .map(ap => ({ ...ap, _nm: distNm(currentLat, currentLon, ap.lat, ap.lon) }))
            .sort((a, b) => a._nm - b._nm)[0];
        if (nearestAirport?.icao) loadAviationBriefing(nearestAirport.icao);

    } catch (err) {
        console.error('loadLocation error:', err);
        $('#mainError').querySelector('p').textContent =
            err.message && err.message !== 'Failed to fetch'
                ? err.message
                : 'Unable to load weather data. Check your connection and try again.';
        $('#mainError').classList.remove('hidden');
    } finally {
        $('#mainLoading').classList.add('hidden');
        $('#nfzLoading').classList.add('hidden');
    }
}

/* ── Hero ──────────────────────────────────────────────────────── */
function renderHero(d, dr, name) {
    const c = d.current;
    $('#locationName').textContent  = name;
    $('#timezone').textContent      = d.timezone || '';
    $('#currentIcon').className     = `wi ${safeIcon(c.icon)}`;
    $('#currentTemp').textContent   = toTemp(c.temp);
    const heroUnit = document.querySelector('.hero-unit');
    if (heroUnit) heroUnit.textContent = tempUnit();
    $('#currentDesc').textContent   = c.desc;
    $('#feelsLike').textContent     = toTemp(c.feels_like);
    $('#wind').textContent          = `${c.wind_dir} ${toWind(c.wind_speed)} ${windUnit()}`;
    $('#gusts').textContent         = `${toWind(c.wind_gusts)} ${windUnit()}`;
    $('#humidity').textContent      = c.humidity;
    $('#pressure').textContent      = Math.round(c.pressure);
    $('#cloudCover').textContent    = c.cloud_cover ?? '—';
    $('#heroCard').querySelector('.hero-bg').className = 'hero-bg ' + (c.group || 'clear');

    if (dr) {
        const vc = dr.verdict === 'GO' ? 'go' : dr.verdict === 'NO-GO' ? 'no-go' : 'marginal';
        $('#heroCard').className         = `card card-hero ${vc}`;
        $('#droneVerdict').textContent   = dr.verdict;
        $('#droneVerdict').className     = `verdict-pill ${vc}`;
        $('#droneSummary').textContent   = dr.summary;
    }
}

/* ── Hourly ────────────────────────────────────────────────────── */
function renderHourly(wh, dh) {
    const scroll = $('#hourlyScroll');
    scroll.replaceChildren();
    const hours = wh.slice(0, 24);
    hours.forEach((h, i) => {
        if (i === 12) scroll.appendChild(el('div', 'hourly-row-divider'));
        const ds  = dh[i]?.status || 'good';
        const hr  = parseInt(h.time.split('T')[1]?.split(':')[0] ?? '0', 10);
        const lbl = hr === 0 ? '12a' : hr < 12 ? `${hr}a` : hr === 12 ? '12p' : `${hr - 12}p`;

        const item = el('div', 'hour-item');
        item.appendChild(el('div', 'h-time', lbl));
        const icon = document.createElement('i');
        icon.className = `wi ${safeIcon(h.icon)}`;
        item.appendChild(icon);
        item.appendChild(el('div', 'h-temp', `${toTemp(h.temp)}°`));
        item.appendChild(el('div', `fly-dot ${safeStatus(ds)}`));
        const precip = h.precip_prob > 0 ? `${Number(h.precip_prob)}%` : '';
        item.appendChild(el('div', 'h-precip', precip));

        scroll.appendChild(item);
    });
}

/* ── Forecast ──────────────────────────────────────────────────── */
function renderForecast(fc) {
    const lows  = fc.map(f => f.low);
    const highs = fc.map(f => f.high);
    const mn    = Math.min(...lows), mx = Math.max(...highs), sp = mx - mn || 1;
    const list = $('#forecastList');
    list.replaceChildren();
    fc.forEach(f => {
        const dt  = new Date(f.date + 'T12:00:00');
        const lft = ((f.low - mn) / sp * 100).toFixed(1);
        const wid = ((f.high - f.low) / sp * 100).toFixed(1);

        const row = document.createElement('div');
        row.className = 'forecast-row';

        const day = document.createElement('div');
        day.className = 'f-day';
        const dayName = document.createElement('div');
        dayName.className = 'day-name';
        dayName.textContent = dt.toLocaleDateString('en', { weekday: 'short' });
        const dayDate = document.createElement('div');
        dayDate.className = 'day-date';
        dayDate.textContent = dt.toLocaleDateString('en', { month: 'short', day: 'numeric' });
        day.appendChild(dayName);
        day.appendChild(dayDate);

        const icon = document.createElement('i');
        icon.className = `wi ${safeIcon(f.icon)}`;

        const bar = document.createElement('div');
        bar.className = 'f-bar';
        const low = document.createElement('span');
        low.className = 'low';
        low.textContent = `${toTemp(f.low)}°`;
        const tempBar = document.createElement('div');
        tempBar.className = 'temp-bar';
        const tempFill = document.createElement('div');
        tempFill.className = 'temp-fill';
        tempFill.style.setProperty('--temp-left', `${lft}%`);
        tempFill.style.setProperty('--temp-w', `${wid / 100}`);
        tempBar.appendChild(tempFill);
        const high = document.createElement('span');
        high.className = 'high';
        high.textContent = `${toTemp(f.high)}°`;
        bar.appendChild(low);
        bar.appendChild(tempBar);
        bar.appendChild(high);

        const precip = document.createElement('div');
        precip.className = 'f-precip';
        precip.textContent = f.precip_prob > 0 ? `${Number(f.precip_prob)}%` : '';

        const meta = document.createElement('div');
        meta.className = 'f-meta';
        meta.textContent = `${toWind(f.wind_max)} ${windUnit()}`;

        row.appendChild(day);
        row.appendChild(icon);
        row.appendChild(bar);
        row.appendChild(precip);
        row.appendChild(meta);

        const flyAssess = assessDayFlyability(f, droneClass);
        const pill = document.createElement('div');
        pill.className = `fly-pill ${flyAssess.cls}`;
        pill.textContent = flyAssess.verdict;
        pill.dataset.tooltip = flyAssess.tip;
        row.appendChild(pill);
        list.appendChild(row);
    });
}

/* ── Drone factors ─────────────────────────────────────────────── */
function renderDroneFactors(factors) {
    const wrap = $('#droneFactors');
    wrap.replaceChildren();
    factors.forEach(f => {
        const factor = el('div', `drone-factor ${safeStatus(f.status)}`);
        factor.appendChild(el('div', `drone-factor-status ${safeStatus(f.status)}`));

        const info = el('div', 'drone-factor-info');
        info.appendChild(el('div', 'drone-factor-name', f.name));
        info.appendChild(el('div', 'drone-factor-value', f.value));
        info.appendChild(el('div', 'drone-factor-note', f.note));
        factor.appendChild(info);

        wrap.appendChild(factor);
    });
}

/* ── Checklist ─────────────────────────────────────────────────── */
function renderChecklist() {
    const items = [
        'Check local airspace restrictions & TFRs',
        'Verify drone battery is fully charged',
        'Inspect propellers for damage',
        'Confirm GPS lock before takeoff',
        'Set return-to-home altitude',
        'Check for nearby airports (within 5 nm)',
        'Maintain visual line of sight at all times',
        'Do not fly above 400 ft / 120 m AGL',
        'Check for manned aircraft in the area',
        'Have spotter if flying near people',
        'Ensure SD card is inserted & formatted',
        'Remove gimbal cover',
        'Check controller battery level',
        'Verify compass calibration',
        'Check wind speed & gusts',
    ];
    const list = $('#droneChecklist');
    list.replaceChildren();

    const checkAllBtn = el('button', 'checklist-check-all');
    checkAllBtn.type = 'button';
    checkAllBtn.textContent = 'Check All';
    list.before(checkAllBtn);

    items.forEach(c => {
        const row = el('div', 'checklist-item');
        row.append(el('div', 'check-box'), el('span', '', c));
        list.appendChild(row);
    });

    const checklist = list;
    let complete = checklist.nextElementSibling;
    if (!complete || !complete.classList.contains('checklist-complete')) {
        complete = el('div', 'checklist-complete hidden');
        checklist.after(complete);
    }

    const updateComplete = () => {
        const all  = checklist.querySelectorAll('.check-box');
        const done = checklist.querySelectorAll('.check-box.checked');
        const allChecked = all.length > 0 && all.length === done.length;
        checkAllBtn.textContent = allChecked ? 'Uncheck All' : 'Check All';
        if (!allChecked) { complete.classList.add('hidden'); return; }

        const now = new Date();
        const ts  = now.toLocaleDateString('en', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
                  + ' · ' + now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });

        // Checkmark icon
        const checkSvg = svgEl('svg');
        checkSvg.setAttribute('viewBox', '0 0 24 24');
        checkSvg.setAttribute('fill', 'none');
        checkSvg.setAttribute('stroke', 'currentColor');
        checkSvg.setAttribute('stroke-width', '2');
        const checkPath = svgEl('path');
        checkPath.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
        const checkPoly = svgEl('polyline');
        checkPoly.setAttribute('points', '22 4 12 14.01 9 11.01');
        checkSvg.append(checkPath, checkPoly);

        // Text content
        const wrap = el('div');
        wrap.append(el('div', 'cc-title', 'All checks complete'), el('div', 'cc-ts', ts));

        // Print briefing button
        const printBtn = el('button', 'cc-print-btn');
        printBtn.type = 'button';
        printBtn.title = 'Print preflight briefing';
        const printSvg = svgEl('svg');
        printSvg.setAttribute('viewBox', '0 0 24 24');
        printSvg.setAttribute('fill', 'none');
        printSvg.setAttribute('stroke', 'currentColor');
        printSvg.setAttribute('stroke-width', '2');
        printSvg.setAttribute('width', '16');
        printSvg.setAttribute('height', '16');
        const printPoly = svgEl('polyline');
        printPoly.setAttribute('points', '6 9 6 2 18 2 18 9');
        const printPath = svgEl('path');
        printPath.setAttribute('d', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2');
        const printRect = svgEl('rect');
        printRect.setAttribute('x', '6');
        printRect.setAttribute('y', '14');
        printRect.setAttribute('width', '12');
        printRect.setAttribute('height', '8');
        printSvg.append(printPoly, printPath, printRect);
        printBtn.append(printSvg, document.createTextNode(' Print Briefing'));
        printBtn.addEventListener('click', () => {
            const content = generateBriefingContent(checklist);
            if (!content) return;
            try {
                localStorage.setItem('uavchum_briefing_content', content);
                window.open('/static/briefing.html', '_blank');
            } catch (e) {
                alert('Unable to open briefing: ' + e.message);
            }
        });

        complete.replaceChildren(checkSvg, wrap, printBtn);
        complete.classList.remove('hidden');
    };

    checklist.querySelectorAll('.checklist-item').forEach(item => {
        item.addEventListener('click', () => {
            item.querySelector('.check-box').classList.toggle('checked');
            updateComplete();
        });
    });

    checkAllBtn.addEventListener('click', () => {
        const boxes = checklist.querySelectorAll('.check-box');
        const allChecked = boxes.length === checklist.querySelectorAll('.check-box.checked').length;
        boxes.forEach(box => box.classList.toggle('checked', !allChecked));
        updateComplete();
    });
}

/* ── Daylight row ──────────────────────────────────────────────── */
function renderDaylight(forecast, timezone) {
    const row = $('#daylightRow');
    if (!row) return;
    const today = forecast?.[0];
    if (!today?.sunrise || !today?.sunset) { row.classList.add('hidden'); return; }

    const fmt = iso => {
        try {
            return new Date(iso).toLocaleTimeString('en', {
                hour: '2-digit', minute: '2-digit',
                timeZone: timezone || undefined,
            });
        } catch { return (iso.split('T')[1] || '').slice(0, 5); }
    };

    const GOLDEN_MS      = 30 * 60 * 1000;
    const sunriseMs      = new Date(today.sunrise).getTime();
    const sunsetMs       = new Date(today.sunset).getTime();
    const goldenMornStart = new Date(sunriseMs - GOLDEN_MS);
    const goldenMornEnd   = new Date(sunriseMs + GOLDEN_MS);
    const goldenEveStart  = new Date(sunsetMs  - GOLDEN_MS);
    const goldenEveEnd    = new Date(sunsetMs  + GOLDEN_MS);

    $('#sunriseVal').textContent    = fmt(today.sunrise);
    $('#sunsetVal').textContent     = fmt(today.sunset);
    $('#goldenMornVal').textContent = `${fmt(goldenMornStart.toISOString())}–${fmt(goldenMornEnd.toISOString())}`;
    $('#goldenEveVal').textContent  = `${fmt(goldenEveStart.toISOString())}–${fmt(goldenEveEnd.toISOString())}`;

    const civilDawnEl = $('#civilDawnVal');
    const civilDuskEl = $('#civilDuskVal');
    if (civilDawnEl) civilDawnEl.textContent = today.civil_dawn ? fmt(today.civil_dawn) : '—';
    if (civilDuskEl) civilDuskEl.textContent = today.civil_dusk ? fmt(today.civil_dusk) : '—';

    updateDroneLawsLink(currentCountry, currentCountryName);

    row.classList.remove('hidden');
}

function updateDroneLawsLink(countryCode, countryName) {
    const link = $('#droneLawsLink');
    if (!link) return;

    const cc = (countryCode || '').toUpperCase();
    const cName = (countryName || '').trim();

    const rules = {
        AU: {
            label: 'Australia CASA: Drone rules',
            title: 'Civil Aviation Safety Authority (CASA) — Drone rules',
            url: 'https://www.casa.gov.au/drones/drone-rules',
        },
        CA: {
            label: 'Canada: Transport Canada drone safety',
            title: 'Transport Canada — Drone safety',
            url: 'https://tc.canada.ca/en/aviation/drone-safety',
        },
        GB: {
            label: 'UK CAA: Drones',
            title: 'Civil Aviation Authority — Drones',
            url: 'https://www.caa.co.uk/drones/',
        },
        NZ: {
            label: 'New Zealand CAA: Drones',
            title: 'Civil Aviation Authority of New Zealand — Drones',
            url: 'https://www.aviation.govt.nz/drones/',
        },
        US: {
            label: 'USA FAA: UAS',
            title: 'Federal Aviation Administration (FAA) — Unmanned Aircraft Systems (UAS)',
            url: 'https://www.faa.gov/uas',
        },
    };

    const match = rules[cc] || null;
    if (match) {
        link.textContent = match.label;
        link.href = match.url;
        link.title = match.title;
    } else {
        const dl = droneLawsUrl({ countryCode: cc, countryName: cName });
        link.textContent = cName ? `Drone-Laws: ${cName}` : 'Drone-Laws: Countries';
        link.href = dl;
        link.title = cName ? `Drone laws and regulator links for ${cName}` : 'Drone laws by country';
    }
}

function droneLawsUrl({ countryName }) {
    const name = (countryName || '').trim();
    if (!name) return 'https://drone-laws.com/countries/';
    // Slug-based URLs are unreliable (e.g. 'the-ivory-coast', 'the-united-arab-emirates-uae');
    // use their on-site search instead, which always returns the right country page.
    return `https://drone-laws.com/?s=${encodeURIComponent(name + ' Drone Laws')}`;
}

/* ── Visibility / ceiling chips ────────────────────────────────── */
function updateVisibilityCeiling(airports) {
    const sorted = (airports || [])
        .filter(ap => ap.lat && ap.lon)
        .map(ap => ({ ...ap, _nm: distNm(currentLat, currentLon, ap.lat, ap.lon) }))
        .sort((a, b) => a._nm - b._nm);
    const primary = sorted[0];
    if (!primary) return;

    const vis = primary.visibility;
    if (vis && vis !== 'N/A') {
        const el = $('#visCurrent');
        if (el) el.textContent = vis;
        $('#visChip')?.classList.remove('hidden');
    }

    const clouds  = primary.clouds || [];
    const ceiling = clouds.find(c => ['BKN', 'OVC'].includes(c.cover));
    const ceilEl  = $('#ceilCurrent');
    if (ceiling?.base && ceilEl) {
        ceilEl.textContent = `${ceiling.base} ft ${ceiling.cover}`;
        $('#ceilChip')?.classList.remove('hidden');
    } else if (ceilEl && (!clouds.length || clouds.every(c => ['CLR','SKC','NSC'].includes(c.cover)))) {
        ceilEl.textContent = 'CLR';
        $('#ceilChip')?.classList.remove('hidden');
    }
}

/* ── Aviation Briefing ─────────────────────────────────────────── */
async function loadAviationBriefing(icao) {
    if (!icao) return;
    const card = $('#aviationCard');
    if (!card) return;
    card.classList.remove('hidden');
    $('#icaoInput').value = icao.toUpperCase();
    $('#aviationLoading').classList.remove('hidden');
    $('#aviationContent').classList.add('hidden');
    try {
        const d = await fetch(`/api/aviation?station=${encodeURIComponent(icao.toUpperCase())}`).then(r => r.json());
        renderAviation(d);
    } catch (e) { console.error(e); }
    finally { $('#aviationLoading').classList.add('hidden'); }
}

function renderAviation(d) {
    const m = d.metar_decoded;

    if (m) {
        $('#stationCard').classList.remove('hidden');
        $('#stationId').textContent = m.station;
        $('#stationName').textContent = m.name || m.station;
        const meta = [];
        if (m.elevation_ft != null) meta.push(`Elev ${m.elevation_ft} ft`);
        if (m.lat != null) meta.push(`${m.lat.toFixed(3)}° / ${m.lon.toFixed(3)}°`);
        $('#stationMeta').textContent = meta.join(' · ');
        const fc = $('#flightCat');
        fc.textContent = m.flight_cat || '—';
        fc.className = 'flight-cat-pill ' + safeFC(m.flight_cat || '');
        if (_FC_TOOLTIP[m.flight_cat]) fc.dataset.tooltip = _FC_TOOLTIP[m.flight_cat];
    } else {
        $('#stationCard').classList.add('hidden');
    }

    if (m) {
        const metarCard = $('#decodedMetarCard');
        metarCard.classList.remove('hidden');
        if (!metarCard._everShown) { metarCard._everShown = true; metarCard.classList.add('collapsed'); }
        $('#metarTime').textContent = m.time ? new Date(m.time).toUTCString().slice(0, -4) + ' Z' : '';
        const grid = $('#metarGrid');
        grid.replaceChildren();
        const item = (label, value, sub) => {
            const row = el('div', 'mg-item');
            if (METAR_TOOLTIPS[label]) row.dataset.tooltip = METAR_TOOLTIPS[label];
            row.appendChild(el('div', 'mg-label', label));
            row.appendChild(el('div', 'mg-value', value));
            if (sub) row.appendChild(el('div', 'mg-sub', sub));
            return row;
        };
        if (m.temp_c != null) grid.appendChild(item('Temperature', `${m.temp_c}°C`, `${m.temp_f}°F`));
        if (m.dewp_c != null) {
            const spread = m.temp_c != null ? m.temp_c - m.dewp_c : null;
            const dewSub = (spread != null && spread <= 3)
                ? `⚠ Fog/mist risk (spread ${spread}°C)`
                : `${m.dewp_f}°F`;
            grid.appendChild(item('Dew Point', `${m.dewp_c}°C`, dewSub));
        }
        if (m.wind_speed_kt != null) {
            grid.appendChild(item('Wind', fmtWind(m.wind_dir, m.wind_dir_deg, m.wind_speed_kt, m.wind_gust_kt)));
        }
        grid.appendChild(item('Visibility', fmtVis(m.visibility) || 'N/A'));
        if (m.altimeter_hpa != null) {
            grid.appendChild(item('Altimeter', `${m.altimeter_inhg} inHg`, `${m.altimeter_hpa} hPa`));
        }
        if (m.clouds?.length) {
            const cloudTxt = m.clouds.map(c => decodeCloud(c.cover, c.base, c.type)).join(', ');
            grid.appendChild(item('Clouds', cloudTxt));
        }
        if (m.wx_string) grid.appendChild(item('Weather', decodeWx(m.wx_string)));
        $('#metarRaw').textContent = m.raw;
        const history = $('#metarHistory');
        history.replaceChildren();
        if (d.metar.length > 1) {
            history.appendChild(el('div', 'label-small', `Previous Reports (${d.metar.length - 1})`));
            const histList = el('div', 'metar-hist-list');
            d.metar.slice(1).forEach(x => {
                histList.appendChild(renderMetarHistoryRow(x));
            });
            history.appendChild(histList);
        }
        const colBtn = $('#metarCollapseBtn');
        if (colBtn && !colBtn._wired) {
            colBtn._wired = true;
            colBtn.addEventListener('click', () => {
                $('#decodedMetarCard').classList.toggle('collapsed');
            });
        }
        const pirepBtn = $('#pirepCollapseBtn');
        if (pirepBtn && !pirepBtn._wired) {
            pirepBtn._wired = true;
            pirepBtn.addEventListener('click', () => {
                $('#pirepCard').classList.toggle('collapsed');
            });
        }
    } else {
        $('#decodedMetarCard').classList.add('hidden');
    }

    if (d.taf?.length) {
        const tafEl = $('#tafContent');
        tafEl.replaceChildren();
        d.taf.forEach(t => {
            tafEl.appendChild(renderTAFDecoded(t));
        });
    } else {
        const tafEl = $('#tafContent');
        tafEl.replaceChildren();
        tafEl.appendChild(el('div', 'no-data', `No TAF for ${d.station}`));
    }

    if (d.airsigmet?.length) {
        $('#alertCount').textContent = `${d.airsigmet.length} active`;
        const alertContent = $('#alertContent');
        alertContent.replaceChildren();
        d.airsigmet.forEach(a => {
            alertContent.appendChild(renderAlertDecoded(a));
        });
    } else {
        $('#alertCount').textContent = 'None';
        const alertContent = $('#alertContent');
        alertContent.replaceChildren();
        alertContent.appendChild(el('div', 'no-data', 'No active SIGMETs or AIRMETs near this station'));
    }

    if (d.pireps?.length) {
        $('#pirepCount').textContent = `${d.pireps.length}`;
        const pirepContent = $('#pirepContent');
        pirepContent.replaceChildren();
        d.pireps.forEach(p => {
            pirepContent.appendChild(renderPIREPDecoded(p));
        });
    } else {
        $('#pirepCount').textContent = '0';
        const pirepContent = $('#pirepContent');
        pirepContent.replaceChildren();
        pirepContent.appendChild(el('div', 'no-data', 'No recent PIREPs near this station'));
    }

    if (d.notams?.length) {
        const src = d.notam_source ? ` (${d.notam_source})` : '';
        $('#notamCount').textContent = `${d.notams.length}${src}`;
        const SHOW = 3;
        const items = d.notams.map(n => renderNOTAMDecoded(n));
        const notamContent = $('#notamContent');
        notamContent.replaceChildren();
        const visibleItems = items.slice(0, SHOW);
        const hiddenItems  = items.slice(SHOW);
        visibleItems.forEach(n => {
            notamContent.appendChild(n);
        });
        if (hiddenItems.length) {
            const moreWrap = el('div', 'hidden');
            moreWrap.id = 'notam-more';
            hiddenItems.forEach(n => {
                moreWrap.appendChild(n);
            });
            notamContent.appendChild(moreWrap);

            const btn = el('button', 'notam-show-more', `Show ${hiddenItems.length} more ▾`);
            btn.id = 'notam-toggle';
            btn.addEventListener('click', () => {
                const open = !moreWrap.classList.contains('hidden');
                moreWrap.classList.toggle('hidden');
                btn.textContent = open
                    ? `Show ${hiddenItems.length} more ▾`
                    : 'Show less ▴';
            });
            notamContent.appendChild(btn);
        }
    } else {
        $('#notamCount').textContent = '0';
        const notamContent = $('#notamContent');
        notamContent.replaceChildren();
        const msg = el('div', 'no-data');
        msg.appendChild(document.createTextNode(`No NOTAMs found for ${d.station}`));
        if (d.notams_note) {
            const note = el('span', 'note-small');
            note.appendChild(document.createTextNode(d.notams_note));
            if (d.notam_portal_url) {
                const link = document.createElement('a');
                link.className = 'link-blue';
                link.href = d.notam_portal_url;
                link.target = '_blank';
                link.rel = 'noopener';
                link.textContent = `${d.notam_portal_label} →`;
                note.appendChild(document.createTextNode(' '));
                note.appendChild(link);
            }
            msg.appendChild(document.createElement('br'));
            msg.appendChild(note);
        }
        if (d.notams_error) msg.appendChild(document.createTextNode(` — ${d.notams_error}`));
        notamContent.appendChild(msg);
    }

    $('#aviationContent').classList.remove('hidden');
}

/* ── Map constants ─────────────────────────────────────────────── */
const TILE_URL   = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_ATTR  = '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>';
const RADAR_ATTR = 'Radar © <a href="https://www.rainviewer.com">RainViewer</a>';

let _radarLayer        = null;
let _radarRefreshTimer = null;
const RADAR_MAX_SUPPORTED_ZOOM = 7;

const FAA_COLORS = {
    B: { color: '#ef4444', label: 'Class B' },
    C: { color: '#f59e0b', label: 'Class C' },
    D: { color: '#3b82f6', label: 'Class D' },
};
const OAIP = {
    0:  { label: 'Airspace',   color: '#64748b' }, 1: { label: 'Restricted', color: '#f97316' },
    2:  { label: 'Danger',     color: '#fbbf24' }, 3: { label: 'Prohibited', color: '#ef4444' },
    4:  { label: 'CTR',        color: '#3b82f6' }, 5: { label: 'TMA',        color: '#818cf8' },
    6:  { label: 'TIZ',        color: '#818cf8' }, 7: { label: 'TIA',        color: '#818cf8' },
    13: { label: 'ATZ',        color: '#22d3ee' }, 14: { label: 'MATZ',       color: '#a78bfa' },
    18: { label: 'Warning',    color: '#fbbf24' }, 21: { label: 'Gliding',    color: '#86efac' },
    26: { label: 'CTA',        color: '#6366f1' }, 28: { label: 'Other',      color: '#94a3b8' },
};
const ICAO_LETTER = { 0:'A',1:'B',2:'C',3:'D',4:'E',5:'F',6:'G' };
const LAYER_DEFS  = [
    { key:'oaip_danger', label:'Restricted / Danger', color:'#ef4444' },
    { key:'oaip_ctr',    label:'CTR / ATZ / MATZ',   color:'#3b82f6' },
    { key:'oaip_tma',    label:'TMA / CTA',           color:'#818cf8' },
    { key:'oaip_other',  label:'Other Zones',         color:'#94a3b8' },
    { key:'faa_class',   label:'Class B / C / D',     color:'#f59e0b' },
    { key:'uasfm',       label:'LAANC Grids',         color:'#22c55e' },
    { key:'tfr',         label:'TFRs',                color:'#ef4444' },
    { key:'airports',    label:'Airports',             color:'#06b6d4' },
    { key:'adsb',        label:'ADS-B Traffic',         color:'#f97316' },
    { key:'radar',       label:'Radar',                  color:'#22d3ee' },
    { key:'lightning',   label:'Lightning Strikes',      color:'#fbbf24' },
];
/* ── Weather decoding helpers ──────────────────────────────────── */
const WX_PHRASES = {
    'TSRA': 'Thunderstorm + Rain',   '+TSRA': 'Heavy Thunderstorm + Rain',
    'TSGR': 'Thunderstorm + Hail',   'TSPL': 'Thunderstorm + Ice Pellets',
    'TSSN': 'Thunderstorm + Snow',   'TSFZRA': 'Thunderstorm + Freezing Rain',
    'FZRA': 'Freezing Rain',         '+FZRA': 'Heavy Freezing Rain',   '-FZRA': 'Light Freezing Rain',
    'FZDZ': 'Freezing Drizzle',      '-FZDZ': 'Light Freezing Drizzle',
    'FZFG': 'Freezing Fog',          'BLSN': 'Blowing Snow',           'DRSN': 'Drifting Snow',
    'BLDU': 'Blowing Dust',          'BLSA': 'Blowing Sand',
    'SHRA': 'Rain Shower',           '-SHRA': 'Light Rain Shower',     '+SHRA': 'Heavy Rain Shower',
    'SHSN': 'Snow Shower',           '-SHSN': 'Light Snow Shower',
    'SHGR': 'Hail Shower',           'SHGS': 'Graupel Shower',
    'RASN': 'Rain/Snow',             '-RASN': 'Light Rain/Snow',       '+RASN': 'Heavy Rain/Snow',
    'SNRA': 'Snow/Rain',             '-SNRA': 'Light Snow/Rain',
    'BCFG': 'Patchy Fog',            'MIFG': 'Shallow Fog',            'PRFG': 'Partial Fog',
    'VCFG': 'Fog in Vicinity',       'VCSH': 'Showers in Vicinity',    'VCTS': 'Thunderstorm in Vicinity',
    '+RA': 'Heavy Rain',             'RA': 'Rain',                     '-RA': 'Light Rain',
    '+SN': 'Heavy Snow',             'SN': 'Snow',                     '-SN': 'Light Snow',
    '+DZ': 'Heavy Drizzle',          'DZ': 'Drizzle',                  '-DZ': 'Light Drizzle',
    '+GR': 'Heavy Hail',             'GR': 'Hail',
    'GS': 'Graupel',                 '-GS': 'Light Graupel',
    '+PL': 'Heavy Ice Pellets',      'PL': 'Ice Pellets',              '-PL': 'Light Ice Pellets',
    'IC': 'Ice Crystals',            'SG': 'Snow Grains',              '-SG': 'Light Snow Grains',
    'FG': 'Fog',    'BR': 'Mist',    'HZ': 'Haze',   'FU': 'Smoke',
    'DU': 'Dust',   'SA': 'Sand',    'VA': 'Volcanic Ash',   'PY': 'Spray',
    'TS': 'Thunderstorm',   'SQ': 'Squall',   'FC': 'Funnel Cloud',   '+FC': 'Tornado/Waterspout',
    'SS': 'Sandstorm',      '+SS': 'Heavy Sandstorm',   'DS': 'Dust Storm',
    'CAVOK': 'Clear & Vis ≥10 km',  'NSW': 'No significant weather',
};
function decodeWx(wxStr) {
    if (!wxStr) return wxStr;
    if (wxStr === 'CAVOK') return 'Clear & Vis ≥10 km';
    if (wxStr === 'NSW')   return 'No significant weather';
    return wxStr.split(/\s+/).map(w => WX_PHRASES[w] || w).join(', ');
}

const SKY_COVER = {
    'SKC': 'Clear sky',   'CLR': 'Clear sky',    'NSC': 'No significant cloud',
    'NCD': 'No cloud detected',   'CAVOK': 'Clear & Vis ≥10 km',
    'FEW': 'Few clouds',  'SCT': 'Scattered',    'BKN': 'Broken',   'OVC': 'Overcast',
    'VV': 'Vertical visibility',
};
function decodeCloud(cover, base, type) {
    const text = SKY_COVER[cover] || cover;
    if (base == null && ['SKC','CLR','NSC','NCD','CAVOK'].includes(cover)) return text;
    const parts = [text];
    if (base != null) parts.push(`at ${Number(base).toLocaleString()} ft`);
    if (type === 'CB')  parts.push('(Cumulonimbus \u26a0)');
    else if (type === 'TCU') parts.push('(Towering Cu)');
    return parts.join(' ');
}

const TURB_INT  = { 'NEG':'None','SMOOTH':'None','SMTH':'None','NIL':'None','LGT':'Light','LGTMOD':'Light–Mod','MOD':'Moderate','MODSEV':'Mod–Severe','SEV':'Severe','EXTRM':'Extreme','LGT-MOD':'Light–Mod','MOD-SEV':'Mod–Severe' };
const TURB_TYPE = { 'CAT':'Clear-air','CHOP':'Chop','LLWS':'Windshear','MWAVE':'Mt. Wave' };
const TURB_FREQ = { 'ISOL':'Isolated','OCNL':'Occasional','FQT':'Frequent','CONT':'Continuous','INTMT':'Intermittent' };
const ICG_INT   = { 'NEG':'None','TRACE':'Trace','LGT':'Light','LGTMOD':'Light–Mod','MOD':'Moderate','MODSEV':'Mod–Severe','SEV':'Severe','LGT-MOD':'Light–Mod','MOD-SEV':'Mod–Severe' };
const ICG_TYPE  = { 'RIME':'Rime','MIXED':'Mixed','CLEAR':'Clear','CLR':'Clear' };

function decodeTB(tb) {
    if (!tb) return null;
    const tokens = tb.split(/\s+/);
    const parts = [];
    for (const t of tokens) {
        if (TURB_INT[t])  { parts.push(TURB_INT[t]); continue; }
        if (TURB_TYPE[t]) { parts.push(TURB_TYPE[t]); continue; }
        if (TURB_FREQ[t]) { parts.push(TURB_FREQ[t]); continue; }
        if (/^\d{3}-\d{3}$/.test(t)) {
            const [lo, hi] = t.split('-').map(x => Number(x) * 100);
            parts.push(`${lo.toLocaleString()}–${hi.toLocaleString()} ft`); continue;
        }
        if (/^\d{3}$/.test(t)) { parts.push(`above ${Number(t) * 100} ft`); continue; }
        parts.push(t);
    }
    return parts.join(', ') || tb;
}
function decodeIC(ic) {
    if (!ic) return null;
    const tokens = ic.split(/\s+/);
    const parts = [];
    for (const t of tokens) {
        if (ICG_INT[t])  { parts.push(ICG_INT[t]); continue; }
        if (ICG_TYPE[t]) { parts.push(ICG_TYPE[t]); continue; }
        if (/^\d{3}-\d{3}$/.test(t)) {
            const [lo, hi] = t.split('-').map(x => Number(x) * 100);
            parts.push(`${lo.toLocaleString()}–${hi.toLocaleString()} ft`); continue;
        }
        parts.push(t);
    }
    return parts.join(' ') || ic;
}
function turbSevClass(tb) {
    const u = (tb || '').toUpperCase();
    if (u.includes('EXTRM') || (u.includes('SEV') && !u.includes('MOD'))) return 'pirep-sev';
    if (u.includes('MOD')) return 'pirep-mod';
    if (u.includes('LGT')) return 'pirep-lgt';
    return '';
}
function degreesToCompass(deg) {
    if (deg == null || isNaN(deg)) return '';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(Number(deg) / 22.5) % 16];
}

function fmtUTCShort(ts) {
    if (!ts && ts !== 0) return '';
    // obsTime comes as Unix epoch seconds (10-digit number); ISO strings also accepted
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    if (isNaN(d.getTime())) return '';
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2,'0')}/${h}:${m}Z`;
}
// Parse US FAA PIREP format:  UA /OV ORD090040/TM 1430/FL350/TP B737/TB MOD CHOP/IC TRACE RIME
function parsePIREPFields(raw) {
    if (!raw) return {};
    const fields = {};
    raw.split('/').forEach(seg => {
        const m = seg.match(/^\s*([A-Z]{2})\s+([\s\S]+)/);
        if (m) fields[m[1]] = m[2].trim();
    });
    return fields;
}

// Parse ICAO ARP/AIREP format:  ARP BAW7CP 5516N00550W 1708 F360 GOMUP 1730 6000N02000W MS52 221/62 KT GVIIJ ...
// Also handles split lat/lon:  ARP UAL914 5236N 00053W 1127 F340 195/032 TB CONT SMTH IC
const _ICAO_STOP = new Set(['TB','IC','RM','SK','WX','TA','WV']);
function decodeLatLon(s) {
    const m = s.match(/^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/);
    if (!m) return null;
    return `${m[1]}°${m[2]}′${m[3]}  ${m[4]}°${m[5]}′${m[6]}`;
}
function decodeLatLonSplit(lat, lon) {
    const ml = lat.match(/^(\d{2})(\d{2})([NS])$/);
    const mo = lon.match(/^(\d{3})(\d{2})([EW])$/);
    if (!ml || !mo) return null;
    return `${ml[1]}°${ml[2]}′${ml[3]}  ${mo[1]}°${mo[2]}′${mo[3]}`;
}
function parseICAOARP(raw) {
    if (!raw) return null;
    const tokens = raw.trim().split(/\s+/);
    if (!['ARP','UAR','AIREP'].includes(tokens[0])) return null;
    const r = {};
    let i = 1;
    // callsign
    if (tokens[i] && /^[A-Z0-9]{3,8}$/.test(tokens[i]) && !_ICAO_STOP.has(tokens[i])) r.callsign = tokens[i++];
    // position: joined 5516N00550W or split 5236N 00053W
    if (tokens[i] && /^\d{4}[NS]\d{5}[EW]$/.test(tokens[i])) {
        r.position = decodeLatLon(tokens[i++]);
    } else if (tokens[i] && /^\d{4}[NS]$/.test(tokens[i]) && tokens[i+1] && /^\d{5}[EW]$/.test(tokens[i+1])) {
        r.position = decodeLatLonSplit(tokens[i], tokens[i+1]); i += 2;
    }
    // time HHMM
    if (tokens[i] && /^\d{4}$/.test(tokens[i])) { r.time = `${tokens[i].slice(0,2)}:${tokens[i].slice(2)}Z`; i++; }
    // level F360 or M120
    if (tokens[i] && /^[FM]\d{3}$/.test(tokens[i])) {
        const fl = parseInt(tokens[i].slice(1));
        r.level = `FL${fl} (${(fl * 100).toLocaleString()} ft)`; i++;
    }
    // next fix (short word, not a stop marker or number)
    if (tokens[i] && /^[A-Z]{2,5}$/.test(tokens[i]) && !_ICAO_STOP.has(tokens[i]) && !/^\d/.test(tokens[i])) r.nextFix = tokens[i++];
    // ETA HHMM
    if (tokens[i] && /^\d{4}$/.test(tokens[i])) { r.nextETA = `${tokens[i].slice(0,2)}:${tokens[i].slice(2)}Z`; i++; }
    // next significant position (skip — routing only)
    if (tokens[i] && /^\d{4}[NS]\d{5}[EW]$/.test(tokens[i])) i++;
    // temperature MS52 / PS10
    if (tokens[i] && /^[MP][SP]?\d{2}$/.test(tokens[i])) {
        const t = tokens[i];
        r.temp = `${t[0] === 'M' ? '−' : '+'}${parseInt(t.replace(/^[A-Z]+/, ''))}°C`; i++;
    }
    // wind DDD/FF (optional KT/KTS)
    if (tokens[i] && /^\d{3}\/\d{2,3}$/.test(tokens[i])) {
        const [dir, spd] = tokens[i++].split('/');
        if (/^KTS?$/.test(tokens[i])) i++;
        r.wind = `${dir}° at ${spd} kt`;
    }
    // aircraft type (not a stop marker)
    if (tokens[i] && /^[A-Z][A-Z0-9]{1,5}$/.test(tokens[i]) && !_ICAO_STOP.has(tokens[i])) r.aircraft = tokens[i++];
    // scan for TB and IC inline section markers
    while (i < tokens.length) {
        if (tokens[i] === 'TB') {
            i++;
            const toks = [];
            while (i < tokens.length && !_ICAO_STOP.has(tokens[i]) && toks.length < 6) toks.push(tokens[i++]);
            r.turb = toks.join(' ');
        } else if (tokens[i] === 'IC') {
            i++;
            const toks = [];
            while (i < tokens.length && !_ICAO_STOP.has(tokens[i]) && toks.length < 4) toks.push(tokens[i++]);
            r.ice = toks.join(' ');
        } else { i++; }
    }
    return r;
}

function renderTAFDecoded(taf) {
    const card = el('div', 'taf-card');
    if (taf.validTimeFrom && taf.validTimeTo) {
        let hdrText = `Valid ${fmtUTCShort(taf.validTimeFrom)} \u2013 ${fmtUTCShort(taf.validTimeTo)}`;
        if (taf.issueTime) {
            const issueEpoch = new Date(taf.issueTime).getTime() / 1000;
            hdrText += `  \u00b7  Issued ${fmtUTCShort(issueEpoch)}`;
        }
        card.appendChild(el('div', 'taf-valid', hdrText));
    }
    const forecasts = taf.fcsts || [];
    if (!forecasts.length) {
        card.appendChild(el('div', 'raw-block cyan', taf.rawTAF || JSON.stringify(taf)));
        return card;
    }
    forecasts.forEach(f => {
        const ci   = (f.fcstChange || '').toUpperCase();
        const prob = f.probability;

        let extra = '';
        if (ci === 'TEMPO') extra = ' tempo';
        else if (ci === 'BECMG') extra = ' becmg';
        else if (ci === 'PROB') extra = ' prob';
        const period = el('div', `taf-period${extra}`);

        // Label
        let label;
        if      (ci === 'PROB' && prob) label = `${prob}% Chance`;
        else if (ci === 'TEMPO' && prob) label = `${prob}% Chance \u2013 Temporary`;
        else if (ci === 'TEMPO') label = 'Temporary';
        else if (ci === 'BECMG') label = 'Becoming';
        else if (ci === 'FM')   label = 'From';
        else                    label = 'Base Forecast';

        // Time string
        const from = fmtUTCShort(f.timeFrom);
        const to   = fmtUTCShort(f.timeTo);
        const bec  = f.timeBec ? fmtUTCShort(f.timeBec) : null;
        let timeStr;
        if (!ci || ci === 'FM') timeStr = from;
        else if (bec && ci === 'BECMG') timeStr = `${from} \u2013 ${to}  (complete by ${bec})`;
        else timeStr = `${from} \u2013 ${to}`;

        period.appendChild(el('div', 'taf-period-head', `${label}  \u00b7  ${timeStr}`));
        const body = el('div', 'taf-period-body');

        // Wind — wdir is degrees (number) or "VRB"
        if (f.wspd != null) {
            let windText;
            if (f.wdir === 'VRB' || f.wdir === 0) {
                windText = `Variable at ${f.wspd} kt`;
            } else {
                windText = `${f.wdir}\u00b0 (${degreesToCompass(f.wdir)}) at ${f.wspd} kt`;
            }
            if (f.wgst) windText += `, gusts ${f.wgst} kt`;
            body.appendChild(el('div', 'taf-field', `Wind: ${windText}`));
        }

        // Wind shear
        if (f.wshearHgt != null) {
            const shearDir = f.wshearDir != null ? `${f.wshearDir}\u00b0 (${degreesToCompass(f.wshearDir)})` : '\u2014';
            const shearSpd = f.wshearSpd != null ? `${f.wshearSpd} kt` : '\u2014';
            body.appendChild(el('div', 'taf-field taf-wx', `Wind Shear: ${shearDir} / ${shearSpd} at ${(f.wshearHgt * 100).toLocaleString()} ft`));
        }

        // Visibility
        const vis = fmtVis(f.visib);
        if (vis && vis !== 'N/A') body.appendChild(el('div', 'taf-field', `Vis: ${vis}`));

        // Vertical visibility
        if (f.vertVis != null) {
            body.appendChild(el('div', 'taf-field', `Vertical Vis: ${(f.vertVis * 100).toLocaleString()} ft`));
        }

        // Weather
        if (f.wxString) {
            body.appendChild(el('div', 'taf-field taf-wx', `Weather: ${decodeWx(f.wxString)}`));
        }

        // Sky
        if (f.clouds?.length) {
            const clearCovers = new Set(['SKC', 'CLR', 'CAVOK', 'NSC', 'NCD']);
            const layerStr = f.clouds
                .filter(c => c.cover && !clearCovers.has(c.cover))
                .map(c => decodeCloud(c.cover, c.base, c.type))
                .join(', ');
            if (layerStr) body.appendChild(el('div', 'taf-field', `Sky: ${layerStr}`));
            else if (f.clouds.some(c => clearCovers.has(c.cover))) {
                body.appendChild(el('div', 'taf-field', 'Sky: Clear'));
            }
        }

        if (body.childElementCount) period.appendChild(body);
        card.appendChild(period);
    });
    return card;
}

function renderPIREPDecoded(pirep) {
    const card = el('div', 'pirep-card');
    const rawOb = pirep.rawOb || '';
    const isICAO = /^(ARP|UAR|AIREP)\b/.test(rawOb.trim());
    const f   = isICAO ? {} : parsePIREPFields(rawOb);
    const arp = isICAO ? parseICAOARP(rawOb) : null;

    // ── Header (acType = callsign for AIREPs, aircraft type for PIREPs) ──
    const acType  = pirep.acType && pirep.acType !== 'UNKN' ? pirep.acType : (f.TP || arp?.callsign || null);
    const lvlType = pirep.fltLvlType || '';
    const fltLvl  = pirep.fltLvl;
    const flLabel = lvlType === 'DURC' ? 'Climbing'
        : lvlType === 'DURD' ? 'Descending'
        : (fltLvl != null && fltLvl > 0) ? `FL${fltLvl} (${(fltLvl * 100).toLocaleString()} ft)`
        : (arp?.level || (f.FL && f.FL !== 'UNKN' ? `FL${parseInt(f.FL)} (${parseInt(f.FL)*100} ft)` : null));
    const timeStr = pirep.obsTime ? fmtUTCShort(pirep.obsTime) : (f.TM ? `${f.TM}Z` : arp?.time || null);
    const badge   = pirep.pirepType || (isICAO ? 'AIREP' : 'PIREP');

    const hdr = el('div', 'pirep-hdr');
    if (acType) hdr.appendChild(el('span', 'pirep-aircraft', acType));
    // For ICAO, if the JSON also has a separate acType (aircraft type code), show it as a badge
    if (arp?.aircraft && arp.aircraft !== acType) hdr.appendChild(el('span', 'pirep-actype', arp.aircraft));
    if (flLabel) hdr.appendChild(el('span', 'pirep-alt', flLabel));
    if (timeStr) hdr.appendChild(el('span', 'pirep-time', timeStr));
    hdr.appendChild(el('span', 'pirep-type-badge', badge));
    card.appendChild(hdr);

    let fieldCount = 0;
    const addField = (label, value, cls = '') => {
        if (!value && value !== 0) return;
        fieldCount++;
        const row = el('div', 'pirep-field');
        row.appendChild(el('span', 'pirep-field-label', label));
        row.appendChild(el('span', `pirep-field-value${cls ? ' ' + cls : ''}`, value));
        card.appendChild(row);
    };

    // ── Position (ICAO only) ────────────────────────────────────────
    if (arp?.position) addField('Position', arp.position);

    // ── Temperature — JSON field first ─────────────────────────────
    const tempVal = pirep.temp != null
        ? `${pirep.temp > 0 ? '+' : ''}${pirep.temp}°C`
        : (arp?.temp || null);
    addField('Temp', tempVal);

    // ── Wind — JSON fields first ────────────────────────────────────
    const windVal = (pirep.wdir != null && pirep.wspd != null)
        ? `${pirep.wdir}° at ${pirep.wspd} kt`
        : (arp?.wind || null);
    addField('Wind', windVal);

    // ── Turbulence — JSON flat fields tbInt1/tbType1/tbFreq1 ───────
    // API returns flat fields (not arrays): tbInt1, tbType1, tbFreq1, tbBas1, tbTop1
    //                                       tbInt2, tbType2, tbFreq2, tbBas2, tbTop2
    const buildTBLayer = (int, type, freq, bas, top) => {
        if (!int) return null;
        const parts = [];
        const intLabel = TURB_INT[int];
        if (intLabel && intLabel !== 'None') parts.push(intLabel); else if (!intLabel) parts.push(int);
        if (type) parts.push(TURB_TYPE[type] || type);
        if (freq) parts.push(TURB_FREQ[freq] || freq);
        if (bas > 0 && top > 0) parts.push(`FL${bas}–FL${top}`);
        else if (bas > 0) parts.push(`above FL${bas}`);
        return { label: parts.join(', ') || null, isNeg: intLabel === 'None' };
    };
    const tb1 = buildTBLayer(pirep.tbInt1, pirep.tbType1, pirep.tbFreq1, pirep.tbBas1, pirep.tbTop1);
    const tb2 = buildTBLayer(pirep.tbInt2, pirep.tbType2, pirep.tbFreq2, pirep.tbBas2, pirep.tbTop2);
    const hasTBJSON = tb1 || tb2;
    if (hasTBJSON) {
        const allNeg = (!pirep.tbInt1 || TURB_INT[pirep.tbInt1] === 'None')
                    && (!pirep.tbInt2 || TURB_INT[pirep.tbInt2] === 'None');
        if (allNeg) {
            addField('Turbulence', 'None', 'pirep-neg');
        } else {
            const layers = [tb1?.label, tb2?.label].filter(Boolean).join(' / ');
            addField('Turbulence', layers || 'Reported', turbSevClass(pirep.tbInt1 || pirep.tbInt2));
        }
    } else {
        // Fallback: US /TB field or ICAO inline TB section
        const tbRaw = f.TB || arp?.turb || null;
        if (tbRaw !== null) {
            if (!tbRaw || /^(NEG|SMTH|SMOOTH|NIL)/i.test(tbRaw)) addField('Turbulence', 'None', 'pirep-neg');
            else { const d = decodeTB(tbRaw); addField('Turbulence', d || tbRaw, turbSevClass(tbRaw)); }
        } else if (isICAO && /\bTB\b/.test(rawOb)) {
            addField('Turbulence', 'None', 'pirep-neg');
        }
    }

    // ── Icing — JSON flat fields icgInt1/icgType1 ──────────────────
    const buildICLayer = (int, type, bas, top) => {
        if (!int) return null;
        const parts = [];
        const intLabel = ICG_INT[int];
        if (intLabel && intLabel !== 'None') parts.push(intLabel); else if (!intLabel) parts.push(int);
        if (type) parts.push(ICG_TYPE[type] || type);
        if (bas > 0 && top > 0) parts.push(`FL${bas}–FL${top}`);
        else if (bas > 0) parts.push(`above FL${bas}`);
        return { label: parts.join(' ') || null, isNeg: intLabel === 'None' };
    };
    const ic1 = buildICLayer(pirep.icgInt1, pirep.icgType1, pirep.icgBas1, pirep.icgTop1);
    const ic2 = buildICLayer(pirep.icgInt2, pirep.icgType2, pirep.icgBas2, pirep.icgTop2);
    const hasICJSON = ic1 || ic2;
    if (hasICJSON) {
        const allNeg = (!pirep.icgInt1 || ICG_INT[pirep.icgInt1] === 'None')
                    && (!pirep.icgInt2 || ICG_INT[pirep.icgInt2] === 'None');
        if (allNeg) {
            addField('Icing', 'None', 'pirep-neg');
        } else {
            const layers = [ic1?.label, ic2?.label].filter(Boolean).join(' / ');
            addField('Icing', layers || 'Reported');
        }
    } else {
        const icRaw = f.IC || (arp?.ice !== undefined ? arp.ice : null);
        if (icRaw !== null) {
            if (!icRaw || /^(NEG)/i.test(icRaw)) addField('Icing', 'None', 'pirep-neg');
            else { const d = decodeIC(icRaw); addField('Icing', d || icRaw); }
        } else if (isICAO && /\bIC\b/.test(rawOb)) {
            addField('Icing', 'None', 'pirep-neg');
        }
    }

    // ── Sky conditions — JSON clouds array ─────────────────────────
    // API returns clouds as [{cover, base, top}] or null
    const cloudsArr = Array.isArray(pirep.clouds) ? pirep.clouds : null;
    const skyStr = cloudsArr?.filter(c => c.cover && c.cover !== 'UNKN')
        .map(c => decodeCloud(c.cover, c.base, null)).join(', ')
        || f.SK || null;
    if (skyStr && !['UNKNOWN','UNKN','//'].includes(skyStr.toUpperCase())) addField('Sky', skyStr);

    // ── Visibility ─────────────────────────────────────────────────
    if (pirep.visib != null && pirep.visib !== '') addField('Vis', `${pirep.visib} SM`);

    // ── Weather string ─────────────────────────────────────────────
    const wx = pirep.wxString || f.WX || null;
    if (wx && !['','UNKN','//'].includes(wx.toUpperCase())) addField('Weather', decodeWx(wx));

    // ── Next fix (ICAO only) ────────────────────────────────────────
    if (arp?.nextFix) addField('Next fix', arp.nextETA ? `${arp.nextFix} at ${arp.nextETA}` : arp.nextFix);

    // ── Remarks ────────────────────────────────────────────────────
    const rm = f.RM;
    if (rm && !['UNKNOWN','UNKN'].includes(rm.toUpperCase())) addField('Remarks', rm, 'pirep-remark');

    // ── Fallback: raw only if truly nothing decoded ─────────────────
    if (fieldCount === 0) card.appendChild(el('div', 'raw-block raw-block-compact', rawOb));
    return card;
}

/* ── METAR helpers ─────────────────────────────────────────────── */
function fmtVis(vis) {
    if (vis == null || vis === '' || vis === 'N/A') return 'N/A';
    const s = String(vis).replace(/\sSM$/i, '').trim();
    if (s === '6+') return '≥6 SM';
    if (s === '0')  return '<¼ SM';
    const n = parseFloat(s);
    if (!isNaN(n)) {
        if (n >= 6) return '≥6 SM';
        if (n < 0.25) return '<¼ SM';
        return `${+n.toFixed(1)} SM`;
    }
    return s.includes('SM') ? s : `${s} SM`;
}
function fmtWind(dir, dirDeg, spd, gust) {
    if (spd === 0 || spd === '0') return 'Calm';
    let str;
    if (dir === 'VRB' || dirDeg === 'VRB') str = `Variable at ${spd} kt`;
    else if (dirDeg != null && dirDeg !== 'VRB') str = `${dirDeg}° (${dir || ''}) at ${spd} kt`;
    else str = `${dir || ''} ${spd} kt`.trim();
    if (gust) str += `, gusts ${gust} kt`;
    return str;
}
// Render one history METAR row from a raw API METAR object
function renderMetarHistoryRow(m) {
    const row = el('div', 'metar-hist-row');
    const left = el('div', 'metar-hist-left');
    const timeStr = m.obsTime ? fmtUTCShort(m.obsTime) : (m.reportTime ? fmtUTCShort(m.reportTime) : '');
    if (timeStr) left.appendChild(el('span', 'metar-hist-time', timeStr));
    if (m.fltCat) {
        const fc = el('span', `flight-cat-pill fc-sm ${safeFC(m.fltCat)}`, m.fltCat);
        left.appendChild(fc);
    }
    row.appendChild(left);
    const right = el('div', 'metar-hist-right');
    if (m.temp != null) right.appendChild(el('span', 'metar-hist-item', `${m.temp}°C`));
    if (m.wspd != null) {
        const dir = m.wdir === 'VRB' ? 'VRB' : (m.wdir != null ? `${m.wdir}°` : '');
        const gust = m.wgst ? `/G${m.wgst}` : '';
        right.appendChild(el('span', 'metar-hist-item', `${dir} ${m.wspd}${gust} kt`.trim()));
    }
    if (m.visib != null) right.appendChild(el('span', 'metar-hist-item', fmtVis(`${m.visib} SM`)));
    if (m.wxString) right.appendChild(el('span', 'metar-hist-item metar-hist-wx', decodeWx(m.wxString)));
    const cloudsArr = Array.isArray(m.clouds) && m.clouds.length ? m.clouds
        : (m.cover && !['CLR','SKC','NSC','NCD'].includes(m.cover) ? [{cover: m.cover}] : null);
    if (cloudsArr?.length) {
        const cText = cloudsArr.filter(c => c.cover && !['CLR','SKC','NSC','NCD'].includes(c.cover))
            .map(c => decodeCloud(c.cover, c.base, c.type)).join(', ');
        if (cText) right.appendChild(el('span', 'metar-hist-item', cText));
    }
    if (!right.childElementCount) right.appendChild(el('span', 'metar-hist-item', m.rawOb || ''));
    row.appendChild(right);
    return row;
}

/* ── SIGMET/AIRMET helpers ─────────────────────────────────────── */
const _STATE_NAMES = {
    'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
    'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
    'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
    'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
    'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri',
    'MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey',
    'NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio',
    'OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
    'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
    'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
    'CSTL':'Coastal','WTRS':'Waters','CSTL WTRS':'Coastal Waters',
    'ATLC':'Atlantic','OCNC':'Oceanic','GULF':'Gulf',
};
function _expandArea(s) {
    // Try full phrase first, then word by word
    if (_STATE_NAMES[s]) return _STATE_NAMES[s];
    return s.split(/\s+/).map(w => _STATE_NAMES[w] || w).join(' ');
}
function _parsePhenomenon(line) {
    const parts = [];
    const structM = line.match(/\b(LINE|AREA|ISOL|EMBD)\b/);
    const sevM    = line.match(/\b(SEV|MOD|LGT)\b/);
    const typeM   = line.match(/\b(TS|TURB|ICG|FZRA|VA|LLWS)\b/);
    const widthM  = line.match(/(\d+)\s*NM\s*WIDE/i);
    const topsM   = line.match(/TOPS\s+(TO|ABV)?\s*FL(\d+)/i);
    const movLtlM = line.match(/MOV\s+LTL/i);
    const movFrmM = line.match(/MOV\s+FROM\s+(\d{3})(\d{2})KT/i);
    const movDirM = !movFrmM && line.match(/MOV\s+(N|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW|NNE)\b/i);
    const SEV = { SEV:'Severe', MOD:'Moderate', LGT:'Light' };
    const STRUCT = { LINE:'Line of', AREA:'Area of', ISOL:'Isolated', EMBD:'Embedded' };
    const TYPE = { TS:'thunderstorms', TURB:'turbulence', ICG:'icing', FZRA:'freezing rain', VA:'volcanic ash', LLWS:'low-level windshear' };
    const sev = sevM ? (SEV[sevM[1]] + ' ') : '';
    const typ = typeM ? (TYPE[typeM[1]] || typeM[1]) : '';
    if (structM) parts.push(`${STRUCT[structM[1]]} ${sev}${typ}`.trim());
    else if (typ) parts.push(`${sev}${typ}`.trim());
    if (widthM) parts.push(`${widthM[1]} NM wide`);
    if      (movLtlM) parts.push('stationary');
    else if (movFrmM) parts.push(`moving from ${movFrmM[1]}\u00b0 (${degreesToCompass(Number(movFrmM[1]))}) at ${Number(movFrmM[2])} kt`);
    else if (movDirM) parts.push(`moving ${movDirM[1].toUpperCase()}`);
    if (topsM) parts.push(`tops ${(topsM[1]||'').toUpperCase()==='ABV'?'above':'to'} FL${topsM[2]}`);
    return parts.length ? parts.join(', ') : null;
}
function parseAlertBody(raw) {
    if (!raw) return {};
    const lines = raw.replace(/\r\n/g,'\n').split('\n').map(l => l.trim()).filter(Boolean);
    let i = 0;
    // skip bulletin / series / type headers
    while (i < lines.length && (
        /^WS[A-Z0-9]+\s/.test(lines[i]) ||
        /^SIG[A-Z]?\s*$/.test(lines[i]) ||
        /^(CONVECTIVE\s+)?SIGMET\b/i.test(lines[i]) ||
        /^AIRMET\b/i.test(lines[i]) ||
        /^VALID\s+UNTIL\b/i.test(lines[i])
    )) i++;
    const result = {};
    // geographic area (before FROM / OUTLOOK)
    if (i < lines.length && !/^FROM\b/.test(lines[i]) && !/^OUTLOOK\b/.test(lines[i]) && !/^AREA\b/.test(lines[i])) {
        result.area = _expandArea(lines[i]);
        i++;
    }
    // boundary (FROM ...) — skip, VOR refs aren't human-readable
    if (i < lines.length && /^FROM\b/.test(lines[i])) i++;
    // phenomenon line
    if (i < lines.length && !/^OUTLOOK\b/.test(lines[i])) {
        result.phenomenon = _parsePhenomenon(lines[i]);
        i++;
    }
    // outlook
    const olkM = raw.match(/OUTLOOK\s+VALID\s+(\d{6})-(\d{6})/);
    if (olkM) {
        const fmt = s => `${s.slice(2,4)}:${s.slice(4,6)}Z`;
        result.outlook = `${fmt(olkM[1])} \u2013 ${fmt(olkM[2])}`;
    }
    return result;
}

const HAZARD_LABELS = {
    'CONVECTIVE':'Thunderstorm / Convective',  'TURB':'Turbulence',  'TURBULENCE':'Turbulence',
    'ICE':'Icing',  'ICING':'Icing',  'IFR':'IFR Conditions',
    'MTN OBSCN':'Mountain Obscuration',  'SFC WINDS':'Surface Winds',
    'LLWS':'Low-Level Windshear',  'FZLVL':'Freezing Level',
    'VOLCANIC ASH':'Volcanic Ash',  'TROPICAL CYCLONE':'Tropical Cyclone',
    'DUST STORM':'Dust Storm',  'SANDSTORM':'Sandstorm',
};
function renderAlertDecoded(a) {
    const isSig = (a.airSigmetType || '').toUpperCase().includes('SIGMET');
    const item = el('div', `alert-item ${isSig ? 'sigmet' : ''}`);
    const hazard = HAZARD_LABELS[a.hazard] || a.hazard || 'Unknown';
    const typeSeries = [a.airSigmetType, a.seriesId].filter(Boolean).join(' ');
    item.appendChild(el('div', `alert-head ${isSig ? 'sigmet' : 'airmet'}`, `${typeSeries} \u2014 ${hazard}`));
    const info = el('div', 'alert-info');
    if (a.validTimeFrom && a.validTimeTo)
        info.appendChild(el('div', 'alert-field', `Valid: ${fmtUTCShort(a.validTimeFrom)} \u2013 ${fmtUTCShort(a.validTimeTo)}`));
    const lo = (!a.altitudeLow1 && a.altitudeLow1 !== 0) || a.altitudeLow1 === 0 ? 'SFC' : `FL${Math.round(a.altitudeLow1 / 100)}`;
    const hi = a.altitudeHi1 != null ? (a.altitudeHi1 >= 1000 ? `FL${Math.round(a.altitudeHi1 / 100)}` : `${a.altitudeHi1} ft`) : null;
    if (hi) info.appendChild(el('div', 'alert-field', `Altitudes: ${lo} \u2013 ${hi}`));
    // movement from structured fields, with compass direction
    if (a.movementDir != null && a.movementSpd > 0)
        info.appendChild(el('div', 'alert-field', `Movement: from ${a.movementDir}\u00b0 (${degreesToCompass(a.movementDir)}) at ${a.movementSpd} kt`));
    else if (a.movementSpd === 0)
        info.appendChild(el('div', 'alert-field', 'Movement: Stationary'));
    // parsed body fields
    const body = parseAlertBody(a.rawAirSigmet);
    if (body.area) info.appendChild(el('div', 'alert-field', `Area: ${body.area}`));
    if (body.phenomenon) info.appendChild(el('div', 'alert-field', `Description: ${body.phenomenon}`));
    // stationary from raw text when movement fields are null
    if (a.movementDir == null && a.movementSpd == null && body.phenomenon?.includes('stationary'))
        info.appendChild(el('div', 'alert-field', 'Movement: Stationary'));
    if (body.outlook) info.appendChild(el('div', 'alert-field', `Outlook: ${body.outlook} \u2014 further issuances possible`));
    if (info.childElementCount) item.appendChild(info);
    item.appendChild(el('div', 'alert-body', a.rawAirSigmet || ''));
    return item;
}

/* ── NOTAM helpers ─────────────────────────────────────────────── */
const NOTAM_SUBJECTS = {
    'MRXX':'Runway',       'MRLC':'Runway Closed',   'MRLT':'Runway Lights',   'MRHC':'Holding Point',
    'MXXX':'Taxiway',      'MXLC':'Taxiway Closed',  'MXLT':'Taxiway Lights',  'MXAP':'Apron',
    'FAXX':'Aerodrome',    'FALC':'Aerodrome Closed', 'FALT':'Aerodrome Lights','FAWM':'ATC Hours',
    'FADP':'Departure Proc','FAAP':'Arrival Proc',
    'NBXX':'Navaid',       'NBIL':'ILS',              'NBVO':'VOR',             'NBNM':'NDB',
    'NBDM':'DME',          'NBAS':'Radar',
    'OBST':'Obstacle',     'OBXX':'Obstacle',
    'SAXX':'Airspace',     'SACF':'Control Zone',     'SAZZ':'Restricted Area',
    'LCXX':'Lighting',     'LCAT':'Approach Lights',
    'PCXX':'Procedure',
};
function decodeQCode(code) {
    if (!code) return null;
    return NOTAM_SUBJECTS[code] || NOTAM_SUBJECTS[code.slice(0,2) + 'XX'] || null;
}
function fmtNotamTime(t) {
    if (!t || t.length < 10) return t;
    const mo = parseInt(t.slice(2,4));
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${t.slice(4,6)} ${months[mo-1] || mo} ${t.slice(6,8)}:${t.slice(8,10)}Z`;
}
function parseNOTAM(raw) {
    if (!raw) return null;
    const text = raw.replace(/^\(/, '').replace(/\)\s*$/, '');
    const r = {};
    const numM = text.match(/^([A-Z]\d+\/\d{2})\s+NOTAM/);
    if (numM) r.id = numM[1];
    const qM = text.match(/Q\)\s*\w+\/Q(\w{4})/);
    if (qM) r.subject = decodeQCode(qM[1]);
    const bM = text.match(/\bB\)\s*(\d{10})/);
    const cM = text.match(/\bC\)\s*(\d{10}|PERM)/i);
    if (bM) r.from = fmtNotamTime(bM[1]);
    if (cM) r.to = cM[1].toUpperCase() === 'PERM' ? 'Permanent' : fmtNotamTime(cM[1]);
    const eM = text.match(/\bE\)\s*([\s\S]+?)(?:\n[A-Z]\)|$)/);
    if (eM) r.description = eM[1].trim().replace(/\n/g, ' ').replace(/\s*\)$/, '').trim();
    return r;
}
function renderNOTAMDecoded(n) {
    const parsed = parseNOTAM(n.raw || '');
    const item = el('div', 'notam-item');
    const head = el('div', 'notam-head');
    if (parsed?.subject) head.appendChild(el('span', 'notam-cat', parsed.subject));
    if (parsed?.id)      head.appendChild(el('span', 'notam-id',  parsed.id));
    if (n.source)        head.appendChild(el('span', 'notam-source', n.source));
    if (head.childElementCount) item.appendChild(head);
    if (parsed?.from || parsed?.to) {
        const parts = [parsed.from && `From ${parsed.from}`, parsed.to && `to ${parsed.to}`].filter(Boolean);
        item.appendChild(el('div', 'notam-timing', parts.join(' ')));
    }
    if (parsed?.description) item.appendChild(el('div', 'notam-desc', parsed.description));
    else item.appendChild(el('div', 'notam-text', n.raw || ''));
    return item;
}

const LAYER_TOOLTIP = {
    oaip_danger: 'Restricted, Danger & Prohibited zones — drone flight typically requires authorisation',
    oaip_ctr:    'Control Zone / Aerodrome Traffic Zone — ATC permission required for drone ops',
    oaip_tma:    'Terminal Manoeuvring Area / Control Area — upper-level airspace boundaries',
    oaip_other:  'Gliding areas, warning zones, and other designated airspace',
    faa_class:   'FAA Class B (red), C (amber) and D (blue) controlled airspace — ATC authorisation required',
    uasfm:       'LAANC facility map — maximum drone altitude (ft) without ATC authorisation',
    tfr:         'Temporary Flight Restriction — active TFR in effect; no drone ops without a waiver',
    airports:    '5 nm proximity zone — check LAANC or contact ATC before flying near airports',
    adsb:        'Live ADS-B traffic — aircraft positions updated every ~8 seconds',
    radar:       'NEXRAD precipitation radar from RainViewer — refreshed every 5 min',
    lightning:   'Live lightning strikes from Blitzortung — last 30 minutes within 150 nm',
};
const METAR_TOOLTIPS = {
    'Temperature': 'Station air temperature — affects battery performance and drone efficiency',
    'Dew Point':   'Dew point — spread < 3°C between temp and dew point indicates fog or mist risk',
    'Wind':        'Surface wind direction and speed at the reporting station',
    'Visibility':  'Horizontal visibility — VLOS operations typically require ≥ 3 SM / 5 km',
    'Altimeter':   'QNH pressure setting — set on altimeter to read altitude above sea level',
    'Clouds':      'Cloud layers: FEW=1–2, SCT=3–4, BKN=5–7, OVC=8 oktas (base heights in ft AGL)',
    'Weather':     'Present weather: precipitation type, intensity, fog, or other phenomena',
    'Temp':        'Station air temperature',
};
function oaipKey(t) {
    if ([1,2,3].includes(t))     return 'oaip_danger';
    if ([4,13,14].includes(t))   return 'oaip_ctr';
    if ([5,6,7,26].includes(t))  return 'oaip_tma';
    return 'oaip_other';
}
function fmtAlt(lim) {
    if (!lim) return '?';
    const v = Number(lim.value), u = Number(lim.unit), r = Number(lim.referenceDatum);
    if (isNaN(v)) return '?';
    if (u === 6) return `FL${v}`;
    if (v === 0 && r === 0) return 'SFC';
    return `${v} ft${r === 0 ? ' GND' : r === 1 ? ' MSL' : ''}`;
}

/* ── Map setup ─────────────────────────────────────────────────── */
function setupDroneMap(lat, lon, name) {
    // Tear down radar tile layer explicitly (it survives the TileLayer filter below)
    if (_radarLayer) { droneMap?.removeLayer(_radarLayer); _radarLayer = null; }
    if (_radarRefreshTimer) { clearInterval(_radarRefreshTimer); _radarRefreshTimer = null; }

    Object.values(droneLayerGroups).forEach(g => { try { droneMap?.removeLayer(g); } catch{} });
    droneLayerGroups = {};
    LAYER_DEFS.forEach(d => { if (d.key !== 'radar') droneLayerGroups[d.key] = L.layerGroup(); });

    if (droneMap) {
        droneMap.eachLayer(l => { if (!(l instanceof L.TileLayer)) droneMap.removeLayer(l); });
        droneMap.setView([lat, lon], 11);
    } else {
        droneMap = L.map('droneMap', { zoomControl: true });
        L.tileLayer(TILE_URL, {
            attribution: TILE_ATTR + ' | <a href="https://www.openaip.net">OpenAIP</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            maxNativeZoom: 19,
        }).addTo(droneMap);
        droneMap.setView([lat, lon], 11);
        droneMap.on('popupopen', e => {
            setTimeout(() => {
                const el = e.popup.getElement();
                const cs = el?.querySelector('[data-callsign]')?.dataset.callsign;
                if (cs) lookupFlightRoute(cs, el);
            }, 0);
        });
    }
    const pinEl = el('div', 'map-pin map-pin-drone');
    const pin = L.divIcon({ html: pinEl.outerHTML, className: '', iconSize:[16,16], iconAnchor:[8,8] });
    const locPopup = document.createElement('div');
    locPopup.appendChild(el('b', '', name));
    locPopup.appendChild(document.createElement('br'));
    locPopup.appendChild(document.createTextNode('Your location'));
    L.marker([lat, lon], { icon: pin }).bindPopup(locPopup).addTo(droneMap);

    // Kick off async radar fetch — don't block map render
    loadRadarLayer();
}

async function loadRadarLayer() {
    if (!droneMap) return;
    try {
        const resp = await fetch('https://api.rainviewer.com/public/weather-maps.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const frames = data.radar?.past;
        if (!frames?.length) return;
        const latest = frames[frames.length - 1];
        const tileUrl = `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;

        if (_radarLayer) droneMap.removeLayer(_radarLayer);
        _radarLayer = L.tileLayer('', {
            attribution: RADAR_ATTR,
            opacity: 0.65,
            zIndex: 5,
            tileSize: 256,
            maxZoom: 19,
            maxNativeZoom: RADAR_MAX_SUPPORTED_ZOOM,
        });
        _radarLayer.getTileUrl = function(coords) {
            const clampedZoom = Math.min(coords.z, RADAR_MAX_SUPPORTED_ZOOM);
            const zoomDelta = coords.z - clampedZoom;
            const scale = 2 ** Math.max(0, zoomDelta);
            return L.Util.template(tileUrl, {
                ...coords,
                z: clampedZoom,
                x: Math.floor(coords.x / scale),
                y: Math.floor(coords.y / scale),
                r: L.Browser.retina ? '@2x' : '',
            });
        };
        droneLayerGroups.radar = _radarLayer;
        const radarToggle = document.querySelector('[data-layer="radar"]');
        if (!radarToggle || radarToggle.checked) _radarLayer.addTo(droneMap);

        // Refresh every 5 min — only set up once
        if (!_radarRefreshTimer) {
            _radarRefreshTimer = setInterval(loadRadarLayer, 300_000);
        }
    } catch (e) {
        console.warn('Radar fetch failed:', e);
    }
}

/* ── Airspace on map ───────────────────────────────────────────── */
function renderAirspaceOnMap(data) {
    if (!droneMap) return;
    LAYER_DEFS.forEach(d => { if (d.key !== 'radar') droneLayerGroups[d.key] = L.layerGroup(); });
    const alerts = [];

    // FAA Class B/C/D
    const seenCls = new Set();
    (data.airspace || []).forEach(feat => {
        const raw = feat.properties?._class;
        const cls = ['B','C','D'].includes(raw) ? raw : 'D';
        const fc  = FAA_COLORS[cls] || { color:'#3b82f6', label:'Class D' };
        try {
            L.geoJSON(feat, {
                style: { color:fc.color, fillColor:fc.color, fillOpacity:0.12, weight:1.5, opacity:0.8 },
                onEachFeature: (f,l) => {
                    const p  = f.properties || {};
                    const lo = p.LOWER_VAL != null ? `${Number(p.LOWER_VAL)} ${p.LOWER_UOM || 'ft'}` : 'SFC';
                    const hi = p.UPPER_VAL != null ? `${Number(p.UPPER_VAL)} ${p.UPPER_UOM || 'ft'}` : '?';
                    const popup = document.createElement('div');
                    popup.appendChild(el('span', `popup-class ${cls}`, fc.label));
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(el('b', '', p.NAME || 'Controlled Airspace'));
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(document.createTextNode(`Floor: ${lo} · Ceiling: ${hi}`));
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(el('small', '', 'Drone auth required'));
                    l.bindPopup(popup);
                },
            }).addTo(droneLayerGroups.faa_class);
            if (!seenCls.has(cls)) { seenCls.add(cls); alerts.push({ type:'danger', msg:`<strong>${fc.label}</strong> — authorization required.` }); }
        } catch {}
    });

    // LAANC
    (data.uasfm || []).forEach(feat => {
        const p = feat.properties || {}, ceil = p.CEILING;
        const fc = ceil===0||ceil==null ? '#ef4444' : ceil<=100 ? '#f97316' : ceil<=200 ? '#eab308' : '#22c55e';
        try {
            L.geoJSON(feat, {
                style: { color:fc, fillColor:fc, fillOpacity:0.18, weight:1, opacity:0.6 },
                onEachFeature: (f,l) => {
                    const pp = f.properties||{}, ceil = Number(pp.CEILING);
                    const popup = document.createElement('div');
                    popup.appendChild(el('span', 'popup-class uasfm', 'LAANC Grid'));
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(el('b', '', pp.APT1_NAME || pp.APT1_ICAO || 'UAS Zone'));
                    popup.appendChild(document.createElement('br'));
                    const ceilText = pp.CEILING === 0
                        ? 'NO DRONE FLIGHT'
                        : pp.CEILING != null
                            ? `Max ${ceil} ft AGL`
                            : 'Unknown';
                    popup.appendChild(document.createTextNode(ceilText));
                    l.bindPopup(popup);
                },
            }).addTo(droneLayerGroups.uasfm);
        } catch {}
    });

    // OpenAIP
    (data.openaip || []).forEach(feat => {
        const p=feat.properties||{}, t=p.type??0, s=OAIP[t]||OAIP[0];
        try {
            L.geoJSON(feat, {
                style: { color:s.color, fillColor:s.color, fillOpacity:0.12, weight:1.5, opacity:0.8 },
                onEachFeature: (f,l) => {
                    const pp=f.properties||{}, tt=pp.type??0, ss=OAIP[tt]||OAIP[0], cls=ICAO_LETTER[pp.icaoClass]??'';
                    const popup = document.createElement('div');
                    const badge = el('span', 'popup-class oaip', `${ss.label}${cls ? ' ' + cls : ''}`);
                    badge.dataset.color = '1';
                    badge.style.setProperty('--oaip-bg', `${ss.color}22`);
                    badge.style.setProperty('--oaip-color', ss.color);
                    popup.appendChild(badge);
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(el('b', '', pp.name || 'Airspace'));
                    popup.appendChild(document.createElement('br'));
                    popup.appendChild(document.createTextNode(`Floor: ${fmtAlt(pp.lowerLimit)} · Ceiling: ${fmtAlt(pp.upperLimit)}`));
                    if ([1,2,3,4,13,14].includes(tt)) {
                        popup.appendChild(document.createElement('br'));
                        popup.appendChild(el('small', '', 'Auth may be required'));
                    }
                    l.bindPopup(popup);
                },
            }).addTo(droneLayerGroups[oaipKey(t)]);
        } catch {}
    });
    const prio=[3,1,2,4,13,14], seen=new Set();
    (data.openaip||[]).forEach(feat => {
        const p=feat.properties||{}, t=p.type;
        if (!prio.includes(t)||seen.has(t)) return; seen.add(t);
        const s=OAIP[t]||OAIP[0], sev=[3,1].includes(t)?'danger':t===2?'warn':'info';
        alerts.push({ type:sev, title:s.label, text:`${p.name||'zone'} (${fmtAlt(p.lowerLimit)}–${fmtAlt(p.upperLimit)})` });
    });

    // TFRs
    (data.tfrs||[]).forEach(tfr => {
        const tlat=parseFloat(tfr.lat||tfr.latitude||0), tlon=parseFloat(tfr.lon||tfr.longitude||0);
        if (!tlat||!tlon) return;
        L.circle([tlat,tlon],{ radius:(tfr.radius||5)*1852, color:'#ef4444', fillColor:'#ef4444', fillOpacity:0.1, weight:2, dashArray:'6,4' })
            .bindPopup((() => {
                const popup = document.createElement('div');
                popup.appendChild(el('span', 'popup-class tfr', 'TFR'));
                popup.appendChild(document.createElement('br'));
                popup.appendChild(el('b', '', tfr.notamId || 'TFR'));
                popup.appendChild(document.createElement('br'));
                popup.appendChild(el('small', '', 'Drones prohibited unless auth'));
                return popup;
            })())
            .addTo(droneLayerGroups.tfr);
        alerts.push({ type:'danger', title:'Active TFR', text:`${tfr.notamId||'restriction'} in area.` });
    });

    // Airport circles
    (data.airports||[]).forEach(ap => {
        if (!ap.lat||!ap.lon) return;
        L.circle([ap.lat,ap.lon],{ radius:4630, color:'#06b6d4', fillColor:'#06b6d4', fillOpacity:0.05, weight:1.5, dashArray:'4,4' })
            .bindPopup((() => {
                const popup = document.createElement('div');
                popup.appendChild(el('span', 'popup-class airport', 'Airport'));
                popup.appendChild(document.createElement('br'));
                popup.appendChild(el('b', '', `${ap.icao} — ${ap.name}`));
                popup.appendChild(document.createElement('br'));
                popup.appendChild(el('small', '', 'Check airspace before flying'));
                return popup;
            })())
            .addTo(droneLayerGroups.airports);
    });

    LAYER_DEFS.forEach(d => {
        const g = droneLayerGroups[d.key];
        if (g && typeof g.getLayers === 'function' && g.getLayers().length > 0) g.addTo(droneMap);
    });
    renderLayerToggles();

    const hasZones = (data.airspace||[]).length||(data.uasfm||[]).length||(data.tfrs||[]).length||(data.openaip||[]).length;
    const hasAirports = (data.airports||[]).length > 0;
    if (alerts.length) {
        const summary = $('#nfzSummary');
        summary.replaceChildren();
        alerts.slice(0, 6).forEach(a => {
            const row = el('div', `nfz-alert ${a.type || ''}`);
            const strong = document.createElement('strong');
            strong.textContent = a.title || '';
            row.appendChild(strong);
            row.appendChild(document.createTextNode(` — ${a.text || ''}`));
            summary.appendChild(row);
        });
        $('#nfzSummary').classList.remove('hidden');
    } else if (!hasZones) {
        const msg = hasAirports
            ? 'No restricted airspace detected — airport proximity zones shown on map'
            : 'No airspace data available for this area';
        const summary = $('#nfzSummary');
        summary.replaceChildren();
        const row = el('div', 'nfz-alert info');
        const strong = document.createElement('strong');
        strong.textContent = msg;
        row.appendChild(strong);
        row.appendChild(document.createTextNode(' — always verify with your national authority before flying.'));
        summary.appendChild(row);
        $('#nfzSummary').classList.remove('hidden');
    }
}

function renderLayerToggles() {
    const pop = LAYER_DEFS.filter(d => {
        const group = droneLayerGroups[d.key];
        if (!group) return false;
        if (d.key === 'adsb' || d.key === 'radar' || d.key === 'lightning') return true;
        return group.getLayers().length > 0;
    });
    if (!pop.length) { $('#layerToggles').classList.add('hidden'); return; }
    const toggles = $('#layerToggles');
    // Preserve existing checked state before rebuilding
    const checkedState = {};
    toggles.querySelectorAll('input[data-layer]').forEach(cb => {
        checkedState[cb.dataset.layer] = cb.checked;
    });
    toggles.replaceChildren();
    pop.forEach(d => {
        const label = el('label', 'layer-toggle');
        if (LAYER_TOOLTIP[d.key]) label.dataset.tooltip = LAYER_TOOLTIP[d.key];
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = d.key in checkedState ? checkedState[d.key] : true;
        input.dataset.layer = d.key;
        const dot = el('span', 'ldot');
        dot.dataset.color = '1';
        dot.style.setProperty('--dot-color', d.color);
        label.appendChild(input);
        label.appendChild(dot);
        label.appendChild(document.createTextNode(d.label));
        toggles.appendChild(label);
    });
    toggles.querySelectorAll('input').forEach(cb => {
        cb.addEventListener('change', () => {
            const g = droneLayerGroups[cb.dataset.layer];
            if (g) cb.checked ? g.addTo(droneMap) : droneMap.removeLayer(g);
        });
    });
    toggles.classList.remove('hidden');
}

/* ── ADS-B traffic layer ───────────────────────────────────────────────────── */
async function renderAdsbLayer() {
    if (!droneMap || !droneLayerGroups.adsb) return;
    if (droneMap.hasLayer(droneLayerGroups.adsb)) droneMap.removeLayer(droneLayerGroups.adsb);
    droneLayerGroups.adsb = L.layerGroup();

    try {
        const resp = await fetch(`/api/adsb?lat=${currentLat}&lon=${currentLon}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        (data.aircraft || []).forEach(ac => {
            if (ac.lat == null || ac.lon == null) return;
            const hdg  = ac.heading ?? 0;
            const altFt = ac.alt_m != null ? Math.round(ac.alt_m * 3.28084) + ' ft' : (ac.on_ground ? 'Ground' : '?');
            const spd   = ac.velocity_ms != null ? Math.round(ac.velocity_ms * 1.944) + ' kt' : '?';
            const iconWrap = el('div', 'adsb-icon');
            iconWrap.dataset.rot = '1';
            iconWrap.style.setProperty('--adsb-rot', `${hdg}deg`);
            const svg = svgEl('svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'currentColor');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            const path = svgEl('path');
            path.setAttribute('d', 'M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71L12 2z');
            svg.appendChild(path);
            iconWrap.appendChild(svg);
            const icon  = L.divIcon({
                html: iconWrap.outerHTML,
                className: '',
                iconSize: [20, 20],
                iconAnchor: [10, 10],
            });
            const callsign = (ac.callsign || '').trim();
            const label    = callsign || ac.icao24;
            const hasCallsign = callsign.length >= 3;
            const reg      = ac.registration || '';
            const acType   = ac.ac_type || '';
            const squawk   = ac.squawk || '';
            const vrate    = ac.baro_rate != null
                ? (ac.baro_rate > 0 ? '▲' : ac.baro_rate < 0 ? '▼' : '→') + ' ' + Math.abs(ac.baro_rate) + ' fpm'
                : null;
            const popup = document.createElement('div');
            popup.appendChild(el('span', 'popup-class adsb', 'ADS-B'));
            popup.appendChild(document.createElement('br'));
            const call = el('b', '', label || '');
            if (hasCallsign) call.dataset.callsign = callsign;
            popup.appendChild(call);
            if (reg) {
                popup.appendChild(document.createTextNode(' · '));
                popup.appendChild(el('span', 'adsb-reg', reg));
            }
            popup.appendChild(document.createElement('br'));
            if (acType) {
                popup.appendChild(el('small', 'adsb-type', acType));
                popup.appendChild(document.createElement('br'));
            }
            const line2 = `Alt: ${altFt} · Spd: ${spd}`;
            popup.appendChild(document.createTextNode(vrate ? line2 + ' · ' : line2));
            if (vrate) popup.appendChild(el('span', 'adsb-vrate', vrate));
            popup.appendChild(document.createElement('br'));
            const metaLine = [ac.icao24, squawk ? 'Sq: ' + squawk : ''].filter(Boolean).join(' · ');
            popup.appendChild(el('small', '', metaLine));
            popup.appendChild(el('div', 'adsb-route'));
            L.marker([ac.lat, ac.lon], { icon })
                .bindPopup(popup)
                .addTo(droneLayerGroups.adsb);
        });
    } catch (e) {
        console.warn('ADS-B fetch failed:', e);
    }

    const adsbToggle = document.querySelector('[data-layer="adsb"]');
    if (!adsbToggle || adsbToggle.checked) droneLayerGroups.adsb.addTo(droneMap);
    renderLayerToggles();
}

function startAdsbRefresh() {
    if (_adsbTimer) clearInterval(_adsbTimer);
    renderAdsbLayer();
    _adsbTimer = setInterval(renderAdsbLayer, 30000);
}

async function lookupFlightRoute(callsign, popupEl) {
    const routeDiv = popupEl?.querySelector('.adsb-route');
    if (!routeDiv) return;
    routeDiv.replaceChildren();
    routeDiv.appendChild(el('span', 'adsb-route-loading', 'Looking up…'));
    try {
        const d = await fetch(`/api/flightroute?callsign=${encodeURIComponent(callsign)}`).then(r => r.json());
        if (!d.found || !d.origin?.iata) {
            routeDiv.replaceChildren();
            routeDiv.appendChild(el('span', 'adsb-route-none', 'Route unknown'));
            return;
        }
        const org = d.origin, dst = d.destination;
        routeDiv.replaceChildren();
        if (d.airline) routeDiv.appendChild(el('div', 'adsb-route-airline', d.airline));
        const row = el('div', 'adsb-route-row');
        const orgEl = el('span', 'adsb-route-ap');
        orgEl.appendChild(el('b', '', org.iata || ''));
        orgEl.appendChild(document.createTextNode(` ${org.municipality || org.name || ''}`));
        const arrow = el('span', 'adsb-route-arrow', '→');
        const dstEl = el('span', 'adsb-route-ap');
        dstEl.appendChild(el('b', '', dst.iata || ''));
        dstEl.appendChild(document.createTextNode(` ${dst.municipality || dst.name || ''}`));
        row.appendChild(orgEl);
        row.appendChild(arrow);
        row.appendChild(dstEl);
        routeDiv.appendChild(row);
    } catch {
        routeDiv.replaceChildren();
        routeDiv.appendChild(el('span', 'adsb-route-none', 'Lookup failed'));
    }
}

/* ── Lightning strikes layer ───────────────────────────────────── */
async function renderLightningLayer() {
    if (!droneMap || !droneLayerGroups.lightning) return;
    if (droneMap.hasLayer(droneLayerGroups.lightning)) droneMap.removeLayer(droneLayerGroups.lightning);
    droneLayerGroups.lightning = L.layerGroup();

    try {
        const resp = await fetch(`/api/lightning?lat=${currentLat}&lon=${currentLon}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        (data.strikes || []).forEach(s => {
            const age = s.age_s;
            let color, opacity;
            if (age < 300)        { color = '#ef4444'; opacity = 0.9; }      // < 5 min  red
            else if (age < 600)   { color = '#f97316'; opacity = 0.75; }     // < 10 min orange
            else if (age < 1200)  { color = '#fbbf24'; opacity = 0.6; }      // < 20 min yellow
            else                  { color = '#94a3b8'; opacity = 0.4; }      // < 30 min grey

            const ageLabel = age < 60 ? `${age}s ago`
                : age < 3600 ? `${Math.round(age / 60)}m ago`
                : `${Math.round(age / 3600)}h ago`;

            const popup = document.createElement('div');
            popup.appendChild(el('span', 'popup-class lightning', 'Lightning'));
            popup.appendChild(document.createElement('br'));
            popup.appendChild(document.createTextNode(ageLabel));

            L.circleMarker([s.lat, s.lon], {
                radius: 5,
                color,
                fillColor: color,
                fillOpacity: opacity,
                weight: 1,
                opacity,
            }).bindPopup(popup).addTo(droneLayerGroups.lightning);
        });

        updateLightningFactor(data.nearest_nm, data.count);
    } catch (e) {
        console.warn('Lightning fetch failed:', e);
    }

    droneLayerGroups.lightning.addTo(droneMap);
    renderLayerToggles();
}

function startLightningRefresh() {
    if (_lightningTimer) clearInterval(_lightningTimer);
    renderLightningLayer();
    _lightningTimer = setInterval(renderLightningLayer, 60_000);
}

function updateLightningFactor(nearestNm, count) {
    const wrap = $('#droneFactors');
    if (!wrap) return;
    // Remove any previous lightning factor
    wrap.querySelector('.lightning-factor')?.remove();

    if (nearestNm == null || count === 0) return;

    let status, note;
    if (nearestNm <= 10)       { status = 'danger';  note = `Lightning ${nearestNm} nm away — do NOT fly`; }
    else if (nearestNm <= 25)  { status = 'caution'; note = `Lightning ${nearestNm} nm away — monitor closely`; }
    else                       { status = 'caution'; note = `Lightning ${nearestNm} nm away — stay alert`; }

    const factor = el('div', `drone-factor ${status} lightning-factor`);
    factor.appendChild(el('div', `drone-factor-status ${status}`));
    const info = el('div', 'drone-factor-info');
    info.appendChild(el('div', 'drone-factor-name', 'Lightning'));
    info.appendChild(el('div', 'drone-factor-value', `${count} strike${count !== 1 ? 's' : ''} in 30 min`));
    info.appendChild(el('div', 'drone-factor-note', note));
    factor.appendChild(info);
    wrap.appendChild(factor);
}

/* ── Airports ──────────────────────────────────────────────────── */
function renderAirports(airports) {
    if (!airports?.length) { $('#airportsCard').classList.add('hidden'); return; }
    const sorted = airports
        .filter(ap => ap.lat && ap.lon)
        .map(ap => ({ ...ap, _nm: distNm(currentLat, currentLon, ap.lat, ap.lon) }))
        .sort((a,b) => a._nm - b._nm)
        .slice(0, 5);
    if (!sorted.length) { $('#airportsCard').classList.add('hidden'); return; }

    $('#airportCount').textContent = sorted.length;
    const [primary, ...rest] = sorted;

    const distLabel = primary._nm < 1 ? '<1' : Math.round(primary._nm);
    const elevLabel = primary.elev != null ? ` · Elev ${Math.round(primary.elev)} ft` : '';
    const fc = safeFC(primary.flight_cat);
    const wrap = document.createElement('div');
    const primaryWrap = document.createElement('div');
    primaryWrap.className = 'airport-primary';

    const header = document.createElement('div');
    header.className = 'airport-primary-hdr';
    header.appendChild(el('span', 'station-id', primary.icao));

    const info = document.createElement('div');
    info.className = 'airport-primary-info';
    info.appendChild(el('div', 'airport-name', primary.name || ''));
    info.appendChild(el('div', 'airport-dist', `${distLabel} nm away${elevLabel}`));
    header.appendChild(info);
    if (fc) {
        const fcEl = el('span', `flight-cat-pill ${fc}`, fc);
        if (_FC_TOOLTIP[fc]) fcEl.dataset.tooltip = _FC_TOOLTIP[fc];
        header.appendChild(fcEl);
    }
    primaryWrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'metar-grid';
    const mg = (label, value, sub = '') => {
        const item = el('div', 'mg-item');
        if (METAR_TOOLTIPS[label]) item.dataset.tooltip = METAR_TOOLTIPS[label];
        item.appendChild(el('div', 'mg-label', label));
        item.appendChild(el('div', 'mg-value', value));
        if (sub) item.appendChild(el('div', 'mg-sub', sub));
        return item;
    };
    if (primary.temp_c != null) grid.appendChild(mg('Temp', `${primary.temp_c}°C`));
    if (primary.wind_speed_kt != null) {
        const wind = `${primary.wind_dir || ''} ${primary.wind_speed_kt} kt`.trim();
        const gust = primary.wind_gust_kt ? `Gusts ${primary.wind_gust_kt} kt` : '';
        grid.appendChild(mg('Wind', wind, gust));
    }
    if (primary.visibility) grid.appendChild(mg('Visibility', primary.visibility));
    if (primary.clouds?.length) {
        const cs = primary.clouds
            .filter(c => c.cover)
            .map(c => decodeCloud(c.cover, c.base, c.type))
            .join(', ');
        if (cs) grid.appendChild(mg('Clouds', cs));
    }
    if (primary.wx_string) grid.appendChild(mg('Weather', decodeWx(primary.wx_string)));

    if (grid.childElementCount) primaryWrap.appendChild(grid);

    if (primary.raw) {
        const rawWrap = el('div', 'metar-raw-wrap');
        rawWrap.appendChild(el('div', 'label-small', 'Raw METAR'));
        rawWrap.appendChild(el('div', 'raw-block', primary.raw));
        primaryWrap.appendChild(rawWrap);
    }

    wrap.appendChild(primaryWrap);

    if (rest.length) {
        const secondary = el('div', 'airports-secondary');
        rest.forEach(ap => {
            const row = el('div', 'airport-row');
            row.appendChild(el('span', 'airport-row-icao', ap.icao));
            const rowInfo = el('div', 'airport-row-info');
            rowInfo.appendChild(el('span', 'airport-row-name', ap.name || ''));
            rowInfo.appendChild(el('span', 'airport-row-dist', `${ap._nm < 1 ? '<1' : Math.round(ap._nm)} nm`));
            row.appendChild(rowInfo);

            const rowMeta = el('div', 'airport-row-meta');
            const wind = ap.wind_speed_kt != null ? `${ap.wind_dir || ''} ${ap.wind_speed_kt}kt`.trim() : '';
            if (wind) rowMeta.appendChild(el('span', 'airport-row-wind', wind));
            const f = safeFC(ap.flight_cat);
            if (f) {
                const smEl = el('span', `flight-cat-sm ${f}`, f);
                if (_FC_TOOLTIP[f]) smEl.dataset.tooltip = _FC_TOOLTIP[f];
                rowMeta.appendChild(smEl);
            }
            row.appendChild(rowMeta);

            secondary.appendChild(row);
        });
        wrap.appendChild(secondary);
    }

    const content = $('#airportsContent');
    content.replaceChildren(wrap);
    $('#airportsCard').classList.remove('hidden');
}

/* ── Sources ───────────────────────────────────────────────────── */
function fmtAge(secs) {
    if (secs < 60)    return 'just now';
    if (secs < 3600)  return `${Math.floor(secs/60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
    return `${Math.floor(secs/86400)}d ago`;
}

function renderSources(sources) {
    if (!sources?.length) { $('#sourcesCard').classList.add('hidden'); return; }
    const now = Date.now() / 1000;
    const list = $('#sourcesList');
    list.replaceChildren();
    sources.forEach(s => {
        const ago = s.ts ? fmtAge(now - s.ts) : '';
        const row = el('div', 'source-row');

        const info = el('div', 'source-info');
        info.appendChild(el('span', 'source-name', s.name));
        info.appendChild(el('span', 'source-type', s.type));

        const meta = el('div', 'source-meta');
        const count = el('span', `source-count ${s.features > 0 ? '' : 'none'}`, `${Number(s.features)} features`);
        meta.appendChild(count);
        meta.appendChild(el('span', `source-status ${s.live ? 'live' : 'cached'}`, s.live ? 'Live' : 'Cached'));
        if (ago) meta.appendChild(el('span', 'source-ts', ago));

        row.appendChild(info);
        row.appendChild(meta);
        list.appendChild(row);
    });
    $('#sourcesCard').classList.remove('hidden');
}

/* ── Drone class selector ──────────────────────────────────────── */
(function setupDroneClass() {
    const sel = $('#droneClassSelect');
    if (!sel) return;
    sel.value = droneClass;
    sel.addEventListener('change', () => {
        droneClass = sel.value;
        localStorage.setItem('droneClass', droneClass);
        if (!currentWxData) return;
        const dr = assessDrone(currentWxData, droneClass);
        const name = $('#locationName').textContent;
        renderHero(currentWxData, dr, name);
        renderHourly(currentWxData.hourly, dr.hourly);
        renderDroneFactors(dr.factors);
    });
})();

/* ── Unit toggles ──────────────────────────────────────────────── */
(function setupUnitToggles() {
    const wBtn = $('#windUnitToggle');
    const tBtn = $('#tempUnitToggle');
    if (!wBtn || !tBtn) return;

    function updateLabels() {
        wBtn.textContent = units.wind === 'kn' ? 'kn' : 'km/h';
        tBtn.textContent = units.temp === 'C' ? '°C' : '°F';
    }
    updateLabels();

    wBtn.addEventListener('click', () => {
        units.wind = units.wind === 'kn' ? 'kmh' : 'kn';
        localStorage.setItem('windUnit', units.wind);
        updateLabels();
        if (!currentWxData) return;
        const dr = assessDrone(currentWxData, droneClass);
        renderHero(currentWxData, dr, $('#locationName').textContent);
        renderHourly(currentWxData.hourly, dr.hourly);
        renderForecast(currentWxData.forecast);
    });

    tBtn.addEventListener('click', () => {
        units.temp = units.temp === 'C' ? 'F' : 'C';
        localStorage.setItem('tempUnit', units.temp);
        updateLabels();
        if (!currentWxData) return;
        const dr = assessDrone(currentWxData, droneClass);
        renderHero(currentWxData, dr, $('#locationName').textContent);
        renderHourly(currentWxData.hourly, dr.hourly);
        renderForecast(currentWxData.forecast);
    });
})();

/* ── Geolocation ───────────────────────────────────────────────── */
(function setupGeo() {
    const btn = $('#geoBtn');
    if (!btn) return;
    if (!navigator.geolocation) { btn.classList.add('hidden'); return; }
    btn.addEventListener('click', () => {
        btn.classList.add('loading');
        navigator.geolocation.getCurrentPosition(
            async pos => {
                const { latitude: lat, longitude: lon } = pos.coords;
                try {
                    const r = await fetch(
                        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
                        { headers: { 'Accept-Language': 'en' } }
                    ).then(r => r.json());
                    const parts = (r?.display_name || '').split(',').map(s => s.trim()).filter(Boolean);
                    const name  = parts.slice(0, 3).join(', ') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
                    const cc    = (r?.address?.country_code || '').toUpperCase();
                    const countryName = (r?.address?.country || '').trim();
                    const elev  = null;
                    $('#locationSearch').value = name;
                    loadLocation(lat, lon, name, cc, elev, countryName);
                } catch {
                    loadLocation(lat, lon, `${lat.toFixed(3)}, ${lon.toFixed(3)}`, '', null, '');
                } finally {
                    btn.classList.remove('loading');
                }
            },
            err => {
                btn.classList.remove('loading');
                console.warn('Geolocation denied:', err.message);
            },
            { timeout: 10000 }
        );
    });
})();


/* ── Preflight Briefing ────────────────────────────────────────── */
function generateBriefingContent(checklistEl) {
    if (!currentWxData) return null;
    const wx     = currentWxData;
    const c      = wx.current;
    const dr     = assessDrone(wx, droneClass);
    const name   = $('#locationName').textContent || 'Unknown Location';
    const now    = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
    const drcls  = droneClass.charAt(0).toUpperCase() + droneClass.slice(1);

    // Factor rows
    const factorRows = dr.factors.map(f => {
        return `<tr>
          <td>${f.name}</td>
          <td>${f.value}</td>
          <td>${f.note}</td>
        </tr>`;
    }).join('');

    // Forecast rows
    const forecastRows = (wx.forecast || []).map(f => {
        const dt   = new Date(f.date + 'T12:00:00');
        const day  = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const fly  = assessDayFlyability(f, droneClass);
        return `<tr class="forecast-row">
          <td class="fc-day">${day}</td>
          <td class="fc-desc">${f.desc}</td>
          <td class="fc-temp">${toTemp(f.low)}°–${toTemp(f.high)}°</td>
          <td class="fc-wind">${toWind(f.wind_max)} ${windUnit()}</td>
          <td class="fc-precip">${f.precip_prob > 0 ? f.precip_prob + '%' : '—'}</td>
          <td><span style="font-weight:bold">${fly.verdict}</span></td>
        </tr>`;
    }).join('');

    // Checklist
    const checkItems = checklistEl
        ? [...checklistEl.querySelectorAll('.checklist-item')].map(row => {
            const checked = row.querySelector('.check-box')?.classList.contains('checked') ?? false;
            const text    = row.querySelector('span')?.textContent ?? '';
            return { checked, text };
          })
        : [];
        
    const checklistRows = checkItems.map(item => {
        const mark = item.checked ? '✓' : '';
        return `<tr>
          <td style="width:32px; text-align:center; font-weight:bold;">${mark}</td>
          <td>${item.text}</td>
        </tr>`;
    }).join('');

    return `
<div class="page">
  <button class="print-btn" style="display:none">Print Briefing</button>
  
  <div class="header">
    <div>
      <div class="brand">UAVChum</div>
      <div class="brand-sub">Preflight Briefing</div>
    </div>
    <div class="meta">
      <div><b>${now}</b></div>
      <div>LOCATION: ${name}</div>
      <div>CLASS: ${drcls}</div>
    </div>
  </div>

  <div class="verdict-box">
    ${dr.verdict}
    <div class="verdict-sub">${dr.summary}</div>
  </div>

  <div class="sec-head">Current Telemetry</div>
  <table>
    <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Condition</td><td>${c.desc}</td></tr>
      <tr><td>Temperature</td><td>${toTemp(c.temp)}${tempUnit()} (Feels ${toTemp(c.feels_like)}°)</td></tr>
      <tr><td>Wind</td><td>${c.wind_dir} ${toWind(c.wind_speed)} ${windUnit()}</td></tr>
      <tr><td>Gusts</td><td>${toWind(c.wind_gusts)} ${windUnit()}</td></tr>
      <tr><td>Humidity</td><td>${c.humidity}%</td></tr>
      <tr><td>Pressure</td><td>${Math.round(c.pressure)} hPa</td></tr>
      <tr><td>Cloud Cover</td><td>${c.cloud_cover ?? '—'}%</td></tr>
      <tr><td>Visibility</td><td>${c.visibility != null ? c.visibility + ' km' : '—'}</td></tr>
    </tbody>
  </table>

  <div class="sec-head">System Assessment</div>
  <table>
    <thead><tr><th>Parameter</th><th>Value</th><th>Status Note</th></tr></thead>
    <tbody>${factorRows}</tbody>
  </table>

  <div class="sec-head">Pre-Flight Checklist</div>
  <table>
    <thead><tr><th style="width:32px; text-align:center;">OK</th><th>Item</th></tr></thead>
    <tbody>${checklistRows || '<tr><td></td><td>—</td></tr>'}</tbody>
  </table>

  <div class="sec-head">7-Day Forecast Horizon</div>
  <table>
    <thead><tr><th>Day</th><th>Sky</th><th>Temp</th><th>Wind (Max)</th><th>Precip</th><th>Verdict</th></tr></thead>
    <tbody>${forecastRows}</tbody>
  </table>

  <div class="footer">
    <span>UAVChum Intelligence // uavchum.hehaw.net</span>
    <span>Local Time: ${wx.timezone || 'Unknown'}</span>
  </div>
</div>`;
}
/* ── Share & Print ─────────────────────────────────────────────── */
(function setupSharePrint() {
    $('#shareBtn')?.addEventListener('click', async () => {
        const url = window.location.href;
        try {
            if (navigator.share) {
            await navigator.share({ title: 'UAVChum', url });
            } else {
                await navigator.clipboard.writeText(url);
                const btn = $('#shareBtn');
                if (!btn) return;
                if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent || '';
                btn.replaceChildren();
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('width', '18');
                svg.setAttribute('height', '18');
                const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
                poly.setAttribute('points', '20 6 9 17 4 12');
                svg.appendChild(poly);
                btn.appendChild(svg);
                setTimeout(() => {
                    btn.replaceChildren();
                    btn.textContent = btn.dataset.origLabel || '';
                }, 2000);
            }
        } catch {}
    });
    $('#printBtn')?.addEventListener('click', () => window.print());
})();

(function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js').catch(() => {});
    });
})();

/* ── ICAO input override ───────────────────────────────────────── */
(function setupIcaoInput() {
    const input = $('#icaoInput');
    if (!input) return;
    const go = () => {
        const val = input.value.trim().toUpperCase();
        if (/^[A-Z][A-Z0-9]{2,3}$/.test(val)) loadAviationBriefing(val);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
    $('#icaoBtn')?.addEventListener('click', go);
})();
