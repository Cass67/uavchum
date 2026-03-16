package main

import (
	"fmt"
	"math"
	"time"
)

// ── WMO Weather Codes ─────────────────────────────────────────────────────────

type WMOInfo struct {
	Desc  string `json:"desc"`
	Icon  string `json:"icon"`
	Group string `json:"group"`
}

var wmoTable = map[int]WMOInfo{
	0:  {"Clear sky", "wi-day-sunny", "clear"},
	1:  {"Mainly clear", "wi-day-sunny-overcast", "clear"},
	2:  {"Partly cloudy", "wi-cloud", "cloud"},
	3:  {"Overcast", "wi-cloudy", "cloud"},
	45: {"Fog", "wi-fog", "fog"},
	48: {"Rime fog", "wi-fog", "fog"},
	51: {"Light drizzle", "wi-sprinkle", "rain"},
	53: {"Moderate drizzle", "wi-sprinkle", "rain"},
	55: {"Dense drizzle", "wi-sprinkle", "rain"},
	56: {"Freezing drizzle", "wi-rain-mix", "rain"},
	57: {"Heavy freezing drizzle", "wi-rain-mix", "rain"},
	61: {"Slight rain", "wi-rain", "rain"},
	63: {"Moderate rain", "wi-rain", "rain"},
	65: {"Heavy rain", "wi-rain-wind", "rain"},
	66: {"Freezing rain", "wi-rain-mix", "rain"},
	67: {"Heavy freezing rain", "wi-rain-mix", "rain"},
	71: {"Slight snow", "wi-snow", "snow"},
	73: {"Moderate snow", "wi-snow", "snow"},
	75: {"Heavy snow", "wi-snow-wind", "snow"},
	77: {"Snow grains", "wi-snow", "snow"},
	80: {"Slight showers", "wi-showers", "rain"},
	81: {"Moderate showers", "wi-showers", "rain"},
	82: {"Violent showers", "wi-storm-showers", "rain"},
	85: {"Slight snow showers", "wi-snow", "snow"},
	86: {"Heavy snow showers", "wi-snow-wind", "snow"},
	95: {"Thunderstorm", "wi-thunderstorm", "storm"},
	96: {"Thunderstorm + hail", "wi-thunderstorm", "storm"},
	99: {"Thunderstorm + heavy hail", "wi-thunderstorm", "storm"},
}

var windDirs = []string{
	"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
	"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
}

func decodeWMO(code int) WMOInfo {
	if info, ok := wmoTable[code]; ok {
		return info
	}
	return WMOInfo{"Unknown", "wi-na", "unknown"}
}

func windDirLabel(deg *float64) string {
	if deg == nil {
		return "VRB"
	}
	return windDirs[int(math.Round(*deg/22.5))%16]
}

func hpaToInhg(hpa float64) float64 {
	return math.Round(hpa*0.02953*100) / 100
}

func metersToFt(m float64) int {
	return int(math.Round(m * 3.28084))
}

// ── Civil Twilight ─────────────────────────────────────────────────────────────

func civilTwilightUTC(lat, lon float64, dateStr string) (dawn, dusk *string) {
	date, err := time.Parse("2006-01-02", dateStr[:10])
	if err != nil {
		return nil, nil
	}
	doy := float64(date.YearDay())
	b := 2 * math.Pi * (doy - 1) / 365

	// Solar declination in radians (Spencer 1971)
	dec := 0.006918 -
		0.399912*math.Cos(b) +
		0.070257*math.Sin(b) -
		0.006758*math.Cos(2*b) +
		0.000907*math.Sin(2*b) -
		0.002697*math.Cos(3*b) +
		0.001480*math.Sin(3*b)

	// Equation of time (minutes)
	eot := 229.18 * (0.000075 +
		0.001868*math.Cos(b) -
		0.032077*math.Sin(b) -
		0.014615*math.Cos(2*b) -
		0.040890*math.Sin(2*b))

	solarNoon := 12.0 - lon/15.0 - eot/60.0
	latR := lat * math.Pi / 180.0

	// Zenith 96° = civil twilight (sun 6° below horizon)
	cosHA := (math.Cos(96*math.Pi/180) - math.Sin(latR)*math.Sin(dec)) /
		(math.Cos(latR) * math.Cos(dec))
	if math.Abs(cosHA) > 1 {
		return nil, nil
	}
	haH := (math.Acos(cosHA) * 180 / math.Pi) / 15.0

	toISO := func(utcH float64) string {
		utcH = math.Mod(utcH, 24)
		if utcH < 0 {
			utcH += 24
		}
		h := int(utcH)
		remM := (utcH - float64(h)) * 60
		m := int(remM)
		s := int((remM - float64(m)) * 60)
		t := time.Date(date.Year(), date.Month(), date.Day(), h, m, s, 0, time.UTC)
		return t.Format(time.RFC3339)
	}

	dawnStr := toISO(solarNoon - haH)
	duskStr := toISO(solarNoon + haH)
	return &dawnStr, &duskStr
}

// ── METAR Decode ──────────────────────────────────────────────────────────────

type CloudLayer struct {
	Cover string      `json:"cover"`
	Base  interface{} `json:"base"`
	Type  string      `json:"type"`
}

type MetarDecoded struct {
	Raw        string       `json:"raw"`
	Station    string       `json:"station"`
	Name       string       `json:"name"`
	FlightCat  string       `json:"flight_cat"`
	Time       string       `json:"time"`
	TempC      *float64     `json:"temp_c,omitempty"`
	TempF      *int         `json:"temp_f,omitempty"`
	DewpC      *float64     `json:"dewp_c,omitempty"`
	DewpF      *int         `json:"dewp_f,omitempty"`
	WindDir    string       `json:"wind_dir"`
	WindDirDeg interface{}  `json:"wind_dir_deg"`
	WindSpeedKt *float64    `json:"wind_speed_kt"`
	WindGustKt  *float64    `json:"wind_gust_kt,omitempty"`
	Visibility  string       `json:"visibility"`
	AltimHpa   *float64     `json:"altimeter_hpa,omitempty"`
	AltimInhg  *float64     `json:"altimeter_inhg,omitempty"`
	Clouds     []CloudLayer  `json:"clouds"`
	ElevM      *float64     `json:"elevation_m,omitempty"`
	ElevFt     *int         `json:"elevation_ft,omitempty"`
	WxString   string       `json:"wx_string"`
	Lat        *float64     `json:"lat"`
	Lon        *float64     `json:"lon"`
}

// metarJSON mirrors the aviationweather.gov JSON response shape.
type metarJSON struct {
	RawOb      string      `json:"rawOb"`
	IcaoId     string      `json:"icaoId"`
	Name       string      `json:"name"`
	FltCat     string      `json:"fltCat"`
	ReportTime string      `json:"reportTime"`
	Temp       *float64    `json:"temp"`
	Dewp       *float64    `json:"dewp"`
	Wdir       interface{} `json:"wdir"` // int or "VRB"
	Wspd       *float64    `json:"wspd"`
	Wgst       *float64    `json:"wgst"`
	Visib      interface{} `json:"visib"`
	Altim      *float64    `json:"altim"`
	Clouds     []struct {
		Cover string      `json:"cover"`
		Base  interface{} `json:"base"`
		Type  string      `json:"type"`
	} `json:"clouds"`
	Cover    string   `json:"cover"`
	Elev     *float64 `json:"elev"`
	WxString string   `json:"wxString"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
}

func decodeMetar(m metarJSON) MetarDecoded {
	d := MetarDecoded{
		Raw:       m.RawOb,
		Station:   m.IcaoId,
		Name:      m.Name,
		FlightCat: m.FltCat,
		Time:      m.ReportTime,
		WxString:  m.WxString,
		Lat:       m.Lat,
		Lon:       m.Lon,
	}

	if m.Temp != nil {
		d.TempC = m.Temp
		f := int(math.Round(*m.Temp*9/5 + 32))
		d.TempF = &f
	}
	if m.Dewp != nil {
		d.DewpC = m.Dewp
		f := int(math.Round(*m.Dewp*9/5 + 32))
		d.DewpF = &f
	}

	// wdir can be a number or "VRB"
	switch v := m.Wdir.(type) {
	case float64:
		d.WindDir = windDirs[int(math.Round(v/22.5))%16]
		d.WindDirDeg = v
	case string:
		d.WindDir = "VRB"
		d.WindDirDeg = v
	default:
		d.WindDir = "VRB"
		d.WindDirDeg = nil
	}

	d.WindSpeedKt = m.Wspd
	d.WindGustKt = m.Wgst

	switch v := m.Visib.(type) {
	case float64:
		d.Visibility = fmt.Sprintf("%g SM", v)
	case string:
		if v != "" {
			d.Visibility = v + " SM"
		} else {
			d.Visibility = "N/A"
		}
	default:
		d.Visibility = "N/A"
	}

	if m.Altim != nil {
		d.AltimHpa = m.Altim
		inhg := hpaToInhg(*m.Altim)
		d.AltimInhg = &inhg
	}

	if len(m.Clouds) > 0 {
		for _, c := range m.Clouds {
			d.Clouds = append(d.Clouds, CloudLayer{Cover: c.Cover, Base: c.Base, Type: c.Type})
		}
	} else if m.Cover != "" {
		d.Clouds = []CloudLayer{{Cover: m.Cover, Base: "", Type: ""}}
	} else {
		d.Clouds = []CloudLayer{}
	}

	if m.Elev != nil {
		d.ElevM = m.Elev
		ft := metersToFt(*m.Elev)
		d.ElevFt = &ft
	}

	return d
}

// ── Drone Assessment ──────────────────────────────────────────────────────────

type DroneFactor struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Status string `json:"status"`
	Note   string `json:"note"`
}

type HourlyVerdict struct {
	Time   string `json:"time"`
	Status string `json:"status"`
}

type DroneAssessment struct {
	Verdict string          `json:"verdict"`
	Color   string          `json:"color"`
	Summary string          `json:"summary"`
	Factors []DroneFactor   `json:"factors"`
	Hourly  []HourlyVerdict `json:"hourly"`
}

func factor(name, value, status, note string) DroneFactor {
	return DroneFactor{name, value, status, note}
}

func windFactor(wsKmh, ws float64) DroneFactor {
	val := fmt.Sprintf("%d km/h (%d kn)", int(math.Round(wsKmh)), int(math.Round(ws)))
	switch {
	case wsKmh <= 20:
		return factor("Wind", val, "good", "Light winds — safe for most drones")
	case wsKmh <= 35:
		return factor("Wind", val, "caution", "Moderate winds — small drones will struggle")
	default:
		return factor("Wind", val, "danger", "Strong winds — unsafe for most consumer drones")
	}
}

func gustFactor(wgKmh, wg float64) DroneFactor {
	val := fmt.Sprintf("%d km/h (%d kn)", int(math.Round(wgKmh)), int(math.Round(wg)))
	switch {
	case wgKmh <= 30:
		return factor("Gusts", val, "good", "Gusts within safe limits")
	case wgKmh <= 45:
		return factor("Gusts", val, "caution", "Gusty — expect instability and drift")
	default:
		return factor("Gusts", val, "danger", "Severe gusts — do not fly")
	}
}

func gustRatioFactor(wsKn, wgKn float64) *DroneFactor {
	if wsKn < 3 {
		return nil
	}
	ratio := wgKn / wsKn
	if ratio < 2.0 {
		return nil
	}
	ratioStr := fmt.Sprintf("%.1f× ratio", ratio)
	if ratio >= 3.0 {
		f := factor("Gust Variability", ratioStr, "danger",
			"Extreme gust variability — sudden speed spikes, do not fly")
		return &f
	}
	f := factor("Gust Variability", ratioStr, "caution",
		"High gust variability — expect sudden, unpredictable speed changes")
	return &f
}

func windShearFactor(ws10mKn, ws80mKn float64) *DroneFactor {
	diffKn := ws80mKn - ws10mKn
	if diffKn < 10 {
		return nil
	}
	diffKmh := diffKn * 1.852
	ws80mKmh := int(math.Round(ws80mKn * 1.852))
	val := fmt.Sprintf("%d km/h at 80 m", ws80mKmh)
	if diffKn >= 20 {
		f := factor("Wind Shear", val, "danger",
			fmt.Sprintf("Severe LLWS (+%d km/h above 10 m) — altitude changes will be violent",
				int(math.Round(diffKmh))))
		return &f
	}
	f := factor("Wind Shear", val, "caution",
		fmt.Sprintf("Low-level wind shear (+%d km/h above 10 m) — turbulence on ascent/descent",
			int(math.Round(diffKmh))))
	return &f
}

func densityAltFactor(tempC, pressureHpa, elevM float64) DroneFactor {
	paFt := (1013.25-pressureHpa)*27 + elevM*3.28084
	isaC := 15 - (elevM / 1000 * 6.5)
	daFt := paFt + 120*(tempC-isaC)
	val := fmt.Sprintf("%d ft", int(math.Round(daFt)))
	switch {
	case daFt < 3000:
		return factor("Density Altitude", val, "good", "Normal air density — full thrust available")
	case daFt < 6000:
		return factor("Density Altitude", val, "caution", "Reduced air density — drone may underperform")
	default:
		return factor("Density Altitude", val, "danger", "Very high density altitude — significant thrust loss expected")
	}
}

func precipFactor(precip float64, group string) DroneFactor {
	val := fmt.Sprintf("%g mm", precip)
	if precip == 0 && group != "rain" && group != "snow" && group != "storm" {
		return factor("Precipitation", "None", "good", "Dry conditions")
	}
	if precip < 1 && group != "storm" {
		return factor("Precipitation", val, "caution", "Light precipitation — most drones are not waterproof")
	}
	if precip == 0 {
		val = group
	}
	return factor("Precipitation", val, "danger", "Active precipitation — risk of water damage")
}

func cloudFactor(cloud int) DroneFactor {
	val := fmt.Sprintf("%d%%", cloud)
	switch {
	case cloud <= 50:
		return factor("Cloud Cover", val, "good", "Good visual conditions")
	case cloud <= 80:
		return factor("Cloud Cover", val, "caution", "Overcast — maintain visual line of sight")
	default:
		return factor("Cloud Cover", val, "caution", "Heavy overcast — limited contrast, harder to spot drone")
	}
}

func tempFactor(temp float64) DroneFactor {
	val := fmt.Sprintf("%d°C", int(math.Round(temp)))
	switch {
	case temp >= 5 && temp <= 40:
		return factor("Temperature", val, "good", "Within normal operating range")
	case (temp >= 0 && temp < 5) || (temp > 40 && temp <= 45):
		return factor("Temperature", val, "caution", "Battery performance may be reduced")
	default:
		note := "Extreme temperature — battery failure risk, LiPo danger zone"
		if temp > 45 {
			note = "Extreme heat — risk of overheating"
		}
		return factor("Temperature", val, "danger", note)
	}
}

// WeatherData is passed to assessDrone; mirrors the structure built in handleWeather.
type WeatherData struct {
	Current struct {
		WindSpeed  float64  `json:"wind_speed"`
		WindGusts  float64  `json:"wind_gusts"`
		Wind80m    *float64 `json:"wind_80m"`
		Precip     float64  `json:"precip"`
		Group      string   `json:"group"`
		CloudCover int      `json:"cloud_cover"`
		Temp       float64  `json:"temp"`
		Pressure   float64  `json:"pressure"`
	} `json:"current"`
	Elevation *float64      `json:"elevation"`
	Hourly    []HourlySlot  `json:"hourly"`
}

type HourlySlot struct {
	Time       string  `json:"time"`
	Wind       float64 `json:"wind"`
	Gusts      float64 `json:"gusts"`
	PrecipProb int     `json:"precip_prob"`
	Desc       string  `json:"desc"`
	Group      string  `json:"group"`
}

func assessDrone(wd WeatherData) DroneAssessment {
	c := wd.Current
	var factors []DroneFactor

	factors = append(factors, windFactor(c.WindSpeed*1.852, c.WindSpeed))
	factors = append(factors, gustFactor(c.WindGusts*1.852, c.WindGusts))

	if rf := gustRatioFactor(c.WindSpeed, c.WindGusts); rf != nil {
		factors = append(factors, *rf)
	}
	if c.Wind80m != nil {
		if sf := windShearFactor(c.WindSpeed, *c.Wind80m); sf != nil {
			factors = append(factors, *sf)
		}
	}

	factors = append(factors, precipFactor(c.Precip, c.Group))
	factors = append(factors, cloudFactor(c.CloudCover))
	factors = append(factors, tempFactor(c.Temp))

	pressure := c.Pressure
	if pressure == 0 {
		pressure = 1013.25
	}
	if wd.Elevation != nil {
		factors = append(factors, densityAltFactor(c.Temp, pressure, *wd.Elevation))
	}

	if c.Group == "storm" {
		factors = append(factors, factor("Severe Weather", "Thunderstorm", "danger", "Thunderstorms — do NOT fly"))
	} else if c.Group == "fog" {
		factors = append(factors, factor("Visibility", "Fog", "danger", "Fog — cannot maintain visual line of sight"))
	}

	dangerCount, cautionCount := 0, 0
	for _, f := range factors {
		switch f.Status {
		case "danger":
			dangerCount++
		case "caution":
			cautionCount++
		}
	}

	var verdict, color, summary string
	switch {
	case dangerCount > 0:
		verdict, color, summary = "NO-GO", "red", "Conditions are unsafe for drone flight"
	case cautionCount >= 2:
		verdict, color, summary = "MARGINAL", "amber", "Fly with caution — multiple limiting factors"
	case cautionCount > 0:
		verdict, color, summary = "MARGINAL", "amber", "Mostly OK but check limiting factors"
	default:
		verdict, color, summary = "GO", "green", "Conditions are good for drone flight"
	}

	var hourly []HourlyVerdict
	for _, h := range wd.Hourly {
		hw := h.Wind * 1.852
		hg := h.Gusts * 1.852
		block := hw > 35 || hg > 45 || h.Group == "storm" || h.Group == "fog"
		issues := 0
		if hw > 20 {
			issues++
		}
		if hg > 30 {
			issues++
		}
		if h.Group == "rain" || h.Group == "snow" {
			issues++
		}
		if h.PrecipProb > 60 {
			issues++
		}
		status := "good"
		if block {
			status = "danger"
		} else if issues >= 2 {
			status = "caution"
		}
		hourly = append(hourly, HourlyVerdict{Time: h.Time, Status: status})
	}

	return DroneAssessment{
		Verdict: verdict,
		Color:   color,
		Summary: summary,
		Factors: factors,
		Hourly:  hourly,
	}
}
