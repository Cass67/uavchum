const $ = s => document.querySelector(s);

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
    } catch (e) {}
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
    items.forEach(c => {
        const row = el('div', 'checklist-item');
        row.appendChild(el('div', 'check-box'));
        row.appendChild(el('span', '', c));
        list.appendChild(row);
    });
    const checklist = list;
    let complete = checklist.nextElementSibling;
    if (!complete || !complete.classList.contains('checklist-complete')) {
        complete = document.createElement('div');
        complete.className = 'checklist-complete hidden';
        checklist.after(complete);
    }

    checklist.querySelectorAll('.checklist-item').forEach(item => {
        item.addEventListener('click', () => {
            item.querySelector('.check-box').classList.toggle('checked');
            const all = checklist.querySelectorAll('.check-box');
            const done = checklist.querySelectorAll('.check-box.checked');
            if (all.length && all.length === done.length) {
                const now = new Date();
                const ts  = now.toLocaleDateString('en', { weekday:'short', year:'numeric', month:'short', day:'numeric' })
                          + ' · ' + now.toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit' });
                complete.replaceChildren();
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
                const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
                poly.setAttribute('points', '22 4 12 14.01 9 11.01');
                svg.appendChild(path);
                svg.appendChild(poly);

                const wrap = document.createElement('div');
                const title = document.createElement('div');
                title.className = 'cc-title';
                title.textContent = 'All checks complete';
                const tsEl = document.createElement('div');
                tsEl.className = 'cc-ts';
                tsEl.textContent = ts;
                wrap.appendChild(title);
                wrap.appendChild(tsEl);

                complete.appendChild(svg);
                complete.appendChild(wrap);
                complete.classList.remove('hidden');
            } else {
                complete.classList.add('hidden');
            }
        });
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
            row.appendChild(el('div', 'mg-label', label));
            row.appendChild(el('div', 'mg-value', value));
            if (sub) row.appendChild(el('div', 'mg-sub', sub));
            return row;
        };
        if (m.temp_c != null) grid.appendChild(item('Temperature', `${m.temp_c}°C`, `${m.temp_f}°F`));
        if (m.dewp_c != null) grid.appendChild(item('Dew Point', `${m.dewp_c}°C`, `${m.dewp_f}°F`));
        if (m.wind_speed_kt != null) {
            const gust = m.wind_gust_kt ? `Gusts ${m.wind_gust_kt} kt` : null;
            grid.appendChild(item('Wind', `${m.wind_dir || ''} ${m.wind_speed_kt} kt`, gust));
        }
        grid.appendChild(item('Visibility', m.visibility || 'N/A'));
        if (m.altimeter_hpa != null) {
            grid.appendChild(item('Altimeter', `${m.altimeter_inhg} inHg`, `${m.altimeter_hpa} hPa`));
        }
        if (m.clouds?.length) {
            const cloudTxt = m.clouds
                .map(c => `${c.cover}${c.base ? ' ' + c.base + ' ft' : ''}${c.type ? ' ' + c.type : ''}`)
                .join(', ');
            grid.appendChild(item('Clouds', cloudTxt));
        }
        if (m.wx_string) grid.appendChild(item('Weather', m.wx_string));
        $('#metarRaw').textContent = m.raw;
        const history = $('#metarHistory');
        history.replaceChildren();
        if (d.metar.length > 1) {
            history.appendChild(el('div', 'label-small', `Previous Reports (${d.metar.length - 1})`));
            d.metar.slice(1).forEach(x => {
                history.appendChild(el('div', 'raw-block raw-block-compact', x.rawOb || ''));
            });
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
        const taf = $('#tafContent');
        taf.replaceChildren();
        d.taf.forEach(t => {
            taf.appendChild(el('div', 'raw-block cyan', t.rawTAF || JSON.stringify(t)));
        });
    } else {
        const taf = $('#tafContent');
        taf.replaceChildren();
        taf.appendChild(el('div', 'no-data', `No TAF for ${d.station}`));
    }

    if (d.airsigmet?.length) {
        $('#alertCount').textContent = `${d.airsigmet.length} active`;
        const alertContent = $('#alertContent');
        alertContent.replaceChildren();
        d.airsigmet.forEach(a => {
            const isSig = (a.airSigmetType || '').toUpperCase().includes('SIGMET');
            const item = el('div', `alert-item ${isSig ? 'sigmet' : ''}`);
            item.appendChild(el('div', `alert-head ${isSig ? 'sigmet' : 'airmet'}`, `${a.airSigmetType || 'ALERT'} — ${a.hazard || ''}`));
            item.appendChild(el('div', 'alert-body', a.rawAirSigmet || ''));
            alertContent.appendChild(item);
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
            pirepContent.appendChild(el('div', 'raw-block raw-block-compact', p.rawOb || JSON.stringify(p)));
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
        const items = d.notams.map(n => {
            const text = n.raw || n.all || n.message || JSON.stringify(n);
            const item = el('div', 'notam-item');
            if (n.source) {
                const head = el('div', 'notam-head');
                head.appendChild(el('span', 'notam-cat', n.source));
                item.appendChild(head);
            }
            item.appendChild(el('div', 'notam-text', text));
            return item;
        });
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

    Object.values(droneLayerGroups).forEach(g => { try { droneMap?.removeLayer(g); } catch(e){} });
    droneLayerGroups = {};
    LAYER_DEFS.forEach(d => { if (d.key !== 'radar') droneLayerGroups[d.key] = L.layerGroup(); });

    if (droneMap) {
        droneMap.eachLayer(l => { if (!(l instanceof L.TileLayer)) droneMap.removeLayer(l); });
        droneMap.setView([lat, lon], 11);
    } else {
        droneMap = L.map('droneMap', { zoomControl: true });
        L.tileLayer(TILE_URL, {
            attribution: TILE_ATTR + ' | <a href="https://www.openaip.net">OpenAIP</a>',
            subdomains: 'abcd', maxZoom: 19,
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
        _radarLayer = L.tileLayer(tileUrl, {
            attribution: RADAR_ATTR,
            opacity: 0.65,
            zIndex: 5,
            tileSize: 256,
        });
        droneLayerGroups.radar = _radarLayer;
        // Only add to map if the toggle isn't currently off
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
        } catch(e) {}
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
        } catch(e) {}
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
        } catch(e) {}
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
        header.appendChild(fcEl);
    }
    primaryWrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'metar-grid';
    const mg = (label, value, sub = '') => {
        const item = el('div', 'mg-item');
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
            .map(c => `${c.cover}${c.base ? ' ' + c.base + ' ft' : ''}`)
            .join(', ');
        if (cs) grid.appendChild(mg('Clouds', cs));
    }
    if (primary.wx_string) grid.appendChild(mg('Weather', primary.wx_string));

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
            if (f) rowMeta.appendChild(el('span', `flight-cat-sm ${f}`, f));
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
        } catch (e) {}
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
