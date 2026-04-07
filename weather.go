package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
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
		Time                     []string  `json:"time"`
		Temperature2m            []float64 `json:"temperature_2m"`
		PrecipitationProbability []int     `json:"precipitation_probability"`
		WeatherCode              []int     `json:"weather_code"`
		WindSpeed10m             []float64 `json:"wind_speed_10m"`
		WindGusts10m             []float64 `json:"wind_gusts_10m"`
		WindSpeed80m             []float64 `json:"wind_speed_80m"`
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

type weatherCacheEntry struct {
	body      []byte
	fetchedAt time.Time
}

type weatherCall struct {
	done  chan struct{}
	entry weatherCacheEntry
	err   error
}

var (
	weatherCache         sync.Map
	weatherInflight      sync.Map
	weatherNow           = time.Now
	weatherCacheFreshTTL = 5 * time.Minute
	weatherCacheStaleTTL = 30 * time.Minute
	weatherRetryDelay    = 200 * time.Millisecond
	weatherMaxAttempts   = 2
)

func handleWeather(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil || !validLat(lat) || !validLon(lon) {
		jsonError(w, "valid lat/lon required", http.StatusBadRequest)
		return
	}

	cacheKey := weatherCacheKey(lat, lon)
	if entry, ok := loadWeatherCache(cacheKey, weatherNow(), weatherCacheFreshTTL); ok {
		writeWeatherResponse(w, entry)
		return
	}

	entry, err := fetchWeatherEntry(r.Context(), cacheKey, latStr, lonStr, lat, lon)
	if err != nil {
		logger.Error("weather fetch failed", "lat", lat, "lon", lon, "err", err)
		jsonError(w, "Weather data unavailable", http.StatusBadGateway)
		return
	}
	writeWeatherResponse(w, entry)
}

func fetchWeatherEntry(ctx context.Context, cacheKey, latStr, lonStr string, lat, lon float64) (weatherCacheEntry, error) {
	now := weatherNow()
	if entry, ok := loadWeatherCache(cacheKey, now, weatherCacheFreshTTL); ok {
		return entry, nil
	}

	call := &weatherCall{done: make(chan struct{})}
	actual, loaded := weatherInflight.LoadOrStore(cacheKey, call)
	if loaded {
		inflight := actual.(*weatherCall)
		select {
		case <-ctx.Done():
			return weatherCacheEntry{}, ctx.Err()
		case <-inflight.done:
			return inflight.entry, inflight.err
		}
	}
	defer func() {
		close(call.done)
		weatherInflight.Delete(cacheKey)
	}()

	entry, err := fetchWeatherFromUpstream(ctx, latStr, lonStr, lat, lon)
	if err == nil {
		weatherCache.Store(cacheKey, entry)
		call.entry = entry
		return entry, nil
	}

	if stale, ok := loadWeatherCache(cacheKey, now, weatherCacheStaleTTL); ok {
		call.entry = stale
		return stale, nil
	}

	call.err = err
	return weatherCacheEntry{}, err
}

func fetchWeatherFromUpstream(ctx context.Context, latStr, lonStr string, lat, lon float64) (weatherCacheEntry, error) {
	var lastErr error
	for attempt := 1; attempt <= weatherMaxAttempts; attempt++ {
		data, err := requestOpenMeteo(ctx, latStr, lonStr, lat, lon)
		if err == nil {
			return buildWeatherEntry(data, lat, lon)
		}
		lastErr = err
		if attempt == weatherMaxAttempts || !isTransientWeatherError(err) {
			break
		}
		if sleepErr := sleepWithContext(ctx, weatherRetryDelay); sleepErr != nil {
			return weatherCacheEntry{}, sleepErr
		}
	}
	return weatherCacheEntry{}, lastErr
}

func requestOpenMeteo(ctx context.Context, latStr, lonStr string, lat, lon float64) (openMeteoResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.open-meteo.com/v1/forecast", nil)
	if err != nil {
		return openMeteoResponse{}, err
	}
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
	req.Header.Set("User-Agent", "UAVChum/1.0")

	resp, err := httpClient.Do(req)
	if err != nil {
		return openMeteoResponse{}, err
	}
	defer resp.Body.Close() //nolint:errcheck,gosec // G104: close errors not actionable after body read
	if resp.StatusCode != http.StatusOK {
		return openMeteoResponse{}, weatherUpstreamError{status: resp.StatusCode}
	}

	var data openMeteoResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(&data); err != nil {
		return openMeteoResponse{}, err
	}
	return data, nil
}

func buildWeatherEntry(data openMeteoResponse, lat, lon float64) (weatherCacheEntry, error) {
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
	body, err := json.Marshal(result)
	if err != nil {
		return weatherCacheEntry{}, err
	}
	return weatherCacheEntry{
		body:      body,
		fetchedAt: weatherNow(),
	}, nil
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
	if err := json.NewEncoder(w).Encode(v); err != nil {
		logger.Error("json encode failed", "err", err)
	}
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"error": msg}); err != nil {
		logger.Error("json encode failed", "err", err)
	}
}

type weatherUpstreamError struct {
	status int
}

func (e weatherUpstreamError) Error() string {
	return fmt.Sprintf("weather upstream status %d", e.status)
}

func weatherCacheKey(lat, lon float64) string {
	return fmt.Sprintf("%.4f,%.4f", lat, lon)
}

func loadWeatherCache(key string, now time.Time, maxAge time.Duration) (weatherCacheEntry, bool) {
	value, ok := weatherCache.Load(key)
	if !ok {
		return weatherCacheEntry{}, false
	}
	entry := value.(weatherCacheEntry)
	if now.Sub(entry.fetchedAt) > maxAge {
		return weatherCacheEntry{}, false
	}
	return entry, true
}

func writeWeatherResponse(w http.ResponseWriter, entry weatherCacheEntry) {
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(entry.body); err != nil {
		logger.Error("weather write failed", "err", err)
	}
}

func isTransientWeatherError(err error) bool {
	var upstreamErr weatherUpstreamError
	if errors.As(err, &upstreamErr) {
		return upstreamErr.status == http.StatusTooManyRequests ||
			upstreamErr.status == http.StatusBadGateway ||
			upstreamErr.status == http.StatusServiceUnavailable ||
			upstreamErr.status == http.StatusGatewayTimeout
	}
	return true
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
