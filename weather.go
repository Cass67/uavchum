package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// open-meteo API response shapes
type openMeteoResponse struct {
	Current struct {
		Temperature2m       float64  `json:"temperature_2m"`
		RelativeHumidity2m  int      `json:"relative_humidity_2m"`
		ApparentTemperature float64  `json:"apparent_temperature"`
		Precipitation       float64  `json:"precipitation"`
		WeatherCode         int      `json:"weather_code"`
		WindSpeed10m        float64  `json:"wind_speed_10m"`
		WindDirection10m    *float64 `json:"wind_direction_10m"`
		WindGusts10m        float64  `json:"wind_gusts_10m"`
		SurfacePressure     float64  `json:"surface_pressure"`
		CloudCover          int      `json:"cloud_cover"`
		IsDay               int      `json:"is_day"`
	} `json:"current"`
	Hourly struct {
		Time                    []string  `json:"time"`
		Temperature2m           []float64 `json:"temperature_2m"`
		PrecipitationProbability []int    `json:"precipitation_probability"`
		WeatherCode             []int     `json:"weather_code"`
		WindSpeed10m            []float64 `json:"wind_speed_10m"`
		WindGusts10m            []float64 `json:"wind_gusts_10m"`
		WindSpeed80m            []float64 `json:"wind_speed_80m"`
	} `json:"hourly"`
	Daily struct {
		Time                        []string  `json:"time"`
		WeatherCode                 []int     `json:"weather_code"`
		Temperature2mMax            []float64 `json:"temperature_2m_max"`
		Temperature2mMin            []float64 `json:"temperature_2m_min"`
		PrecipitationSum            []float64 `json:"precipitation_sum"`
		PrecipitationProbabilityMax []int     `json:"precipitation_probability_max"`
		WindSpeed10mMax             []float64 `json:"wind_speed_10m_max"`
		WindGusts10mMax             []float64 `json:"wind_gusts_10m_max"`
		Sunrise                     []string  `json:"sunrise"`
		Sunset                      []string  `json:"sunset"`
		UvIndexMax                  []float64 `json:"uv_index_max"`
	} `json:"daily"`
	Timezone  string  `json:"timezone"`
	Elevation float64 `json:"elevation"`
}

func handleWeather(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil || !validLat(lat) || !validLon(lon) {
		jsonError(w, "valid lat/lon required", http.StatusBadRequest)
		return
	}

	req, _ := http.NewRequestWithContext(r.Context(), "GET", "https://api.open-meteo.com/v1/forecast", nil)
	q := req.URL.Query()
	q.Set("latitude", latStr)
	q.Set("longitude", lonStr)
	q.Set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,is_day")
	q.Set("hourly", "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_speed_80m")
	q.Set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max")
	q.Set("timezone", "auto")
	q.Set("wind_speed_unit", "kn")
	q.Set("forecast_hours", "24")
	req.URL.RawQuery = q.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		logger.Error("weather API error", "lat", lat, "lon", lon, "err", err)
		jsonError(w, "Weather data unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var data openMeteoResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		jsonError(w, "Unexpected response from weather API", http.StatusBadGateway)
		return
	}

	c := data.Current
	wmo := decodeWMO(c.WeatherCode)

	var hourlySlots []HourlySlot
	h := data.Hourly
	wind80m := h.WindSpeed80m
	for i, t := range h.Time {
		if i >= len(h.WeatherCode) || i >= len(h.Temperature2m) {
			break
		}
		hw := decodeWMO(h.WeatherCode[i])
		var w80 *float64
		if i < len(wind80m) {
			w80 = &wind80m[i]
		}
		_ = w80 // stored in HourlySlot for assessDrone
		slot := HourlySlot{
			Time:       t,
			Wind:       safeIdx(h.WindSpeed10m, i),
			Gusts:      safeIdx(h.WindGusts10m, i),
			PrecipProb: safeIdxInt(h.PrecipitationProbability, i),
			Desc:       hw.Desc,
			Group:      hw.Group,
		}
		hourlySlots = append(hourlySlots, slot)
	}

	var forecastSlots []map[string]interface{}
	d := data.Daily
	for i, date := range d.Time {
		if i >= len(d.WeatherCode) {
			break
		}
		dw := decodeWMO(d.WeatherCode[i])
		civilDawn, civilDusk := civilTwilightUTC(lat, lon, date)
		entry := map[string]interface{}{
			"date":        date,
			"high":        safeIdx(d.Temperature2mMax, i),
			"low":         safeIdx(d.Temperature2mMin, i),
			"desc":        dw.Desc,
			"icon":        dw.Icon,
			"group":       dw.Group,
			"precip":      safeIdx(d.PrecipitationSum, i),
			"precip_prob": safeIdxInt(d.PrecipitationProbabilityMax, i),
			"wind_max":    safeIdx(d.WindSpeed10mMax, i),
			"gusts_max":   safeIdx(d.WindGusts10mMax, i),
			"sunrise":     safeIdxStr(d.Sunrise, i),
			"sunset":      safeIdxStr(d.Sunset, i),
			"uv":          safeIdx(d.UvIndexMax, i),
			"civil_dawn":  civilDawn,
			"civil_dusk":  civilDusk,
		}
		forecastSlots = append(forecastSlots, entry)
	}

	// Use first hourly slot as proxy for current 80m wind
	var wind80mCurrent *float64
	if len(h.WindSpeed80m) > 0 {
		wind80mCurrent = &h.WindSpeed80m[0]
	}

	inhg := hpaToInhg(c.SurfacePressure)
	currentMap := map[string]interface{}{
		"temp":          c.Temperature2m,
		"feels_like":    c.ApparentTemperature,
		"humidity":      c.RelativeHumidity2m,
		"precip":        c.Precipitation,
		"pressure":      c.SurfacePressure,
		"pressure_inhg": inhg,
		"wind_speed":    c.WindSpeed10m,
		"wind_gusts":    c.WindGusts10m,
		"wind_dir":      windDirLabel(c.WindDirection10m),
		"wind_deg":      c.WindDirection10m,
		"cloud_cover":   c.CloudCover,
		"is_day":        c.IsDay,
		"weather_code":  c.WeatherCode,
		"wind_80m":      wind80mCurrent,
		"desc":          wmo.Desc,
		"icon":          wmo.Icon,
		"group":         wmo.Group,
	}

	elev := data.Elevation
	wd := WeatherData{Elevation: &elev}
	wd.Current.WindSpeed = c.WindSpeed10m
	wd.Current.WindGusts = c.WindGusts10m
	wd.Current.Wind80m = wind80mCurrent
	wd.Current.Precip = c.Precipitation
	wd.Current.Group = wmo.Group
	wd.Current.CloudCover = c.CloudCover
	wd.Current.Temp = c.Temperature2m
	wd.Current.Pressure = c.SurfacePressure
	wd.Hourly = hourlySlots

	result := map[string]interface{}{
		"current":   currentMap,
		"hourly":    buildHourlyOutput(data, wind80m),
		"forecast":  forecastSlots,
		"timezone":  data.Timezone,
		"elevation": data.Elevation,
		"drone":     assessDrone(wd),
	}

	jsonOK(w, result)
}

// buildHourlyOutput returns the hourly array in the same shape as the Python.
func buildHourlyOutput(data openMeteoResponse, wind80m []float64) []map[string]interface{} {
	h := data.Hourly
	var out []map[string]interface{}
	for i, t := range h.Time {
		if i >= len(h.WeatherCode) {
			break
		}
		hw := decodeWMO(h.WeatherCode[i])
		var w80 interface{}
		if i < len(wind80m) {
			w80 = wind80m[i]
		}
		out = append(out, map[string]interface{}{
			"time":        t,
			"temp":        safeIdx(h.Temperature2m, i),
			"precip_prob": safeIdxInt(h.PrecipitationProbability, i),
			"icon":        hw.Icon,
			"desc":        hw.Desc,
			"group":       hw.Group,
			"wind":        safeIdx(h.WindSpeed10m, i),
			"gusts":       safeIdx(h.WindGusts10m, i),
			"wind_80m":    w80,
		})
	}
	return out
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func safeIdx(s []float64, i int) float64 {
	if i < len(s) {
		return s[i]
	}
	return 0
}

func safeIdxInt(s []int, i int) int {
	if i < len(s) {
		return s[i]
	}
	return 0
}

func safeIdxStr(s []string, i int) string {
	if i < len(s) {
		return s[i]
	}
	return ""
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
