package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
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

type metNoResponse struct {
	Geometry struct {
		Coordinates []float64 `json:"coordinates"`
	} `json:"geometry"`
	Properties struct {
		Meta struct {
			UpdatedAt string `json:"updated_at"`
		} `json:"meta"`
		Timeseries []struct {
			Time string `json:"time"`
			Data struct {
				Instant struct {
					Details struct {
						AirPressureAtSeaLevel float64 `json:"air_pressure_at_sea_level"`
						AirTemperature        float64 `json:"air_temperature"`
						CloudAreaFraction     float64 `json:"cloud_area_fraction"`
						RelativeHumidity      float64 `json:"relative_humidity"`
						WindFromDirection     float64 `json:"wind_from_direction"`
						WindSpeed             float64 `json:"wind_speed"`
					} `json:"details"`
				} `json:"instant"`
				Next1Hours struct {
					Summary struct {
						SymbolCode string `json:"symbol_code"`
					} `json:"summary"`
					Details struct {
						PrecipitationAmount float64 `json:"precipitation_amount"`
					} `json:"details"`
				} `json:"next_1_hours"`
				Next6Hours struct {
					Summary struct {
						SymbolCode string `json:"symbol_code"`
					} `json:"summary"`
					Details struct {
						PrecipitationAmount float64 `json:"precipitation_amount"`
					} `json:"details"`
				} `json:"next_6_hours"`
			} `json:"data"`
		} `json:"timeseries"`
	} `json:"properties"`
}

type nwsPointsResponse struct {
	Properties struct {
		Forecast       string `json:"forecast"`
		ForecastHourly string `json:"forecastHourly"`
		TimeZone       string `json:"timeZone"`
		Astronomical   struct {
			Sunrise            string `json:"sunrise"`
			Sunset             string `json:"sunset"`
			CivilTwilightBegin string `json:"civilTwilightBegin"`
			CivilTwilightEnd   string `json:"civilTwilightEnd"`
		} `json:"astronomicalData"`
	} `json:"properties"`
}

type nwsForecastResponse struct {
	Properties struct {
		Periods []nwsForecastPeriod `json:"periods"`
	} `json:"properties"`
}

type nwsForecastPeriod struct {
	StartTime                  string `json:"startTime"`
	EndTime                    string `json:"endTime"`
	IsDaytime                  bool   `json:"isDaytime"`
	Temperature                int    `json:"temperature"`
	TemperatureUnit            string `json:"temperatureUnit"`
	WindSpeed                  string `json:"windSpeed"`
	WindDirection              string `json:"windDirection"`
	ShortForecast              string `json:"shortForecast"`
	DetailedForecast           string `json:"detailedForecast"`
	Icon                       string `json:"icon"`
	ProbabilityOfPrecipitation struct {
		Value *float64 `json:"value"`
	} `json:"probabilityOfPrecipitation"`
	RelativeHumidity struct {
		Value *float64 `json:"value"`
	} `json:"relativeHumidity"`
}

type weatherMeta struct {
	Desc  string
	Icon  string
	Group string
}

type normalizedCurrent struct {
	Temp        float64
	FeelsLike   float64
	Humidity    int
	Precip      float64
	Pressure    *float64
	WindSpeed   float64
	WindGusts   float64
	WindDir     string
	WindDeg     *float64
	CloudCover  *int
	IsDay       int
	WeatherCode int
	Wind80m     *float64
	Meta        weatherMeta
}

type normalizedHourly struct {
	Time       string
	Temp       float64
	PrecipProb int
	Wind       float64
	Gusts      float64
	Wind80m    *float64
	Meta       weatherMeta
}

type normalizedForecast struct {
	Date       string
	High       float64
	Low        float64
	Precip     float64
	PrecipProb int
	WindMax    float64
	GustsMax   float64
	Sunrise    string
	Sunset     string
	UV         *float64
	CivilDawn  string
	CivilDusk  string
	Meta       weatherMeta
}

type normalizedWeather struct {
	Current   normalizedCurrent
	Hourly    []normalizedHourly
	Forecast  []normalizedForecast
	Timezone  string
	Elevation *float64
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

	entry, err := fetchWeatherFromProviders(ctx, latStr, lonStr, lat, lon)
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

func fetchWeatherFromProviders(ctx context.Context, latStr, lonStr string, lat, lon float64) (weatherCacheEntry, error) {
	var lastErr error
	for attempt := 1; attempt <= weatherMaxAttempts; attempt++ {
		data, err := requestOpenMeteo(ctx, latStr, lonStr, lat, lon)
		if err == nil {
			return buildWeatherEntryFromNormalized(normalizeOpenMeteo(data), lat, lon)
		}
		lastErr = err
		if attempt == weatherMaxAttempts || !isTransientWeatherError(err) {
			break
		}
		if sleepErr := sleepWithContext(ctx, weatherRetryDelay); sleepErr != nil {
			return weatherCacheEntry{}, sleepErr
		}
	}
	dataMetNo, err := requestMetNo(ctx, lat, lon)
	if err == nil {
		return buildWeatherEntryFromNormalized(normalizeMetNo(dataMetNo), lat, lon)
	}
	lastErr = err

	dataNWS, err := requestNWS(ctx, lat, lon)
	if err == nil {
		return buildWeatherEntryFromNormalized(normalizeNWS(dataNWS), lat, lon)
	}
	if err != nil {
		lastErr = err
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

func requestMetNo(ctx context.Context, lat, lon float64) (metNoResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.met.no/weatherapi/locationforecast/2.0/compact", nil)
	if err != nil {
		return metNoResponse{}, err
	}
	q := req.URL.Query()
	q.Set("lat", strconv.FormatFloat(lat, 'f', 4, 64))
	q.Set("lon", strconv.FormatFloat(lon, 'f', 4, 64))
	req.URL.RawQuery = q.Encode()
	req.Header.Set("User-Agent", "UAVChum/1.0 support@example.invalid")

	resp, err := httpClient.Do(req)
	if err != nil {
		return metNoResponse{}, err
	}
	defer resp.Body.Close() //nolint:errcheck,gosec
	if resp.StatusCode != http.StatusOK {
		return metNoResponse{}, weatherUpstreamError{status: resp.StatusCode}
	}

	var data metNoResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&data); err != nil {
		return metNoResponse{}, err
	}
	return data, nil
}

func requestNWS(ctx context.Context, lat, lon float64) (struct {
	Points nwsPointsResponse
	Hourly nwsForecastResponse
	Daily  nwsForecastResponse
}, error) {
	var out struct {
		Points nwsPointsResponse
		Hourly nwsForecastResponse
		Daily  nwsForecastResponse
	}
	pointsURL := fmt.Sprintf("https://api.weather.gov/points/%.4f,%.4f", lat, lon)
	if err := requestJSON(ctx, pointsURL, &out.Points); err != nil {
		return out, err
	}
	if out.Points.Properties.ForecastHourly == "" || out.Points.Properties.Forecast == "" {
		return out, errors.New("nws forecast endpoints unavailable")
	}
	if err := requestJSON(ctx, out.Points.Properties.ForecastHourly, &out.Hourly); err != nil {
		return out, err
	}
	if err := requestJSON(ctx, out.Points.Properties.Forecast, &out.Daily); err != nil {
		return out, err
	}
	return out, nil
}

func requestJSON(ctx context.Context, url string, dest interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "UAVChum/1.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck,gosec
	if resp.StatusCode != http.StatusOK {
		return weatherUpstreamError{status: resp.StatusCode}
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(dest)
}

func buildWeatherEntryFromNormalized(data normalizedWeather, lat, lon float64) (weatherCacheEntry, error) {
	currentMap := map[string]interface{}{
		"temp":          data.Current.Temp,
		"feels_like":    data.Current.FeelsLike,
		"humidity":      data.Current.Humidity,
		"precip":        data.Current.Precip,
		"pressure":      data.Current.Pressure,
		"pressure_inhg": pressureInHg(data.Current.Pressure),
		"wind_speed":    data.Current.WindSpeed,
		"wind_gusts":    data.Current.WindGusts,
		"wind_dir":      data.Current.WindDir,
		"wind_deg":      data.Current.WindDeg,
		"cloud_cover":   data.Current.CloudCover,
		"is_day":        data.Current.IsDay,
		"weather_code":  data.Current.WeatherCode,
		"wind_80m":      data.Current.Wind80m,
		"desc":          data.Current.Meta.Desc,
		"icon":          data.Current.Meta.Icon,
		"group":         data.Current.Meta.Group,
	}

	hourlySlots := make([]HourlySlot, 0, len(data.Hourly))
	hourlyOut := make([]map[string]interface{}, 0, len(data.Hourly))
	for _, h := range data.Hourly {
		hourlySlots = append(hourlySlots, HourlySlot{
			Time:       h.Time,
			Wind:       h.Wind,
			Gusts:      h.Gusts,
			PrecipProb: h.PrecipProb,
			Desc:       h.Meta.Desc,
			Group:      h.Meta.Group,
		})
		hourlyOut = append(hourlyOut, map[string]interface{}{
			"time":        h.Time,
			"temp":        h.Temp,
			"precip_prob": h.PrecipProb,
			"icon":        h.Meta.Icon,
			"desc":        h.Meta.Desc,
			"group":       h.Meta.Group,
			"wind":        h.Wind,
			"gusts":       h.Gusts,
			"wind_80m":    h.Wind80m,
		})
	}

	forecastOut := make([]map[string]interface{}, 0, len(data.Forecast))
	for _, d := range data.Forecast {
		civilDawn, civilDusk := d.CivilDawn, d.CivilDusk
		if civilDawn == "" || civilDusk == "" {
			dawnPtr, duskPtr := civilTwilightUTC(lat, lon, d.Date)
			if civilDawn == "" && dawnPtr != nil {
				civilDawn = *dawnPtr
			}
			if civilDusk == "" && duskPtr != nil {
				civilDusk = *duskPtr
			}
		}
		forecastOut = append(forecastOut, map[string]interface{}{
			"date":        d.Date,
			"high":        d.High,
			"low":         d.Low,
			"desc":        d.Meta.Desc,
			"icon":        d.Meta.Icon,
			"group":       d.Meta.Group,
			"precip":      d.Precip,
			"precip_prob": d.PrecipProb,
			"wind_max":    d.WindMax,
			"gusts_max":   d.GustsMax,
			"sunrise":     d.Sunrise,
			"sunset":      d.Sunset,
			"uv":          d.UV,
			"civil_dawn":  civilDawn,
			"civil_dusk":  civilDusk,
		})
	}

	wd := WeatherData{Elevation: data.Elevation}
	wd.Current.WindSpeed = data.Current.WindSpeed
	wd.Current.WindGusts = data.Current.WindGusts
	wd.Current.Wind80m = data.Current.Wind80m
	wd.Current.Precip = data.Current.Precip
	wd.Current.Group = data.Current.Meta.Group
	wd.Current.CloudCover = derefInt(data.Current.CloudCover)
	wd.Current.Temp = data.Current.Temp
	wd.Current.Pressure = derefFloat(data.Current.Pressure)
	wd.Hourly = hourlySlots

	result := map[string]interface{}{
		"current":   currentMap,
		"hourly":    hourlyOut,
		"forecast":  forecastOut,
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

func normalizeOpenMeteo(data openMeteoResponse) normalizedWeather {
	c := data.Current
	wmo := decodeWMO(c.WeatherCode)

	out := normalizedWeather{
		Current: normalizedCurrent{
			Temp:        c.Temperature2m,
			FeelsLike:   c.ApparentTemperature,
			Humidity:    c.RelativeHumidity2m,
			Precip:      c.Precipitation,
			Pressure:    ptrFloat64(c.SurfacePressure),
			WindSpeed:   c.WindSpeed10m,
			WindGusts:   c.WindGusts10m,
			WindDir:     windDirLabel(c.WindDirection10m),
			WindDeg:     c.WindDirection10m,
			CloudCover:  ptrInt(c.CloudCover),
			IsDay:       c.IsDay,
			WeatherCode: c.WeatherCode,
			Meta: weatherMeta{
				Desc:  wmo.Desc,
				Icon:  wmo.Icon,
				Group: wmo.Group,
			},
		},
		Timezone:  data.Timezone,
		Elevation: ptrFloat64(data.Elevation),
	}
	if len(data.Hourly.WindSpeed80m) > 0 {
		out.Current.Wind80m = ptrFloat64(data.Hourly.WindSpeed80m[0])
	}
	for i, t := range data.Hourly.Time {
		if i >= len(data.Hourly.WeatherCode) || i >= len(data.Hourly.Temperature2m) {
			break
		}
		hw := decodeWMO(data.Hourly.WeatherCode[i])
		out.Hourly = append(out.Hourly, normalizedHourly{
			Time:       t,
			Temp:       safeIdx(data.Hourly.Temperature2m, i),
			PrecipProb: safeIdxInt(data.Hourly.PrecipitationProbability, i),
			Wind:       safeIdx(data.Hourly.WindSpeed10m, i),
			Gusts:      safeIdx(data.Hourly.WindGusts10m, i),
			Wind80m:    safeIdxPtr(data.Hourly.WindSpeed80m, i),
			Meta: weatherMeta{
				Desc:  hw.Desc,
				Icon:  hw.Icon,
				Group: hw.Group,
			},
		})
	}
	for i, date := range data.Daily.Time {
		if i >= len(data.Daily.WeatherCode) {
			break
		}
		dw := decodeWMO(data.Daily.WeatherCode[i])
		out.Forecast = append(out.Forecast, normalizedForecast{
			Date:       date,
			High:       safeIdx(data.Daily.Temperature2mMax, i),
			Low:        safeIdx(data.Daily.Temperature2mMin, i),
			Precip:     safeIdx(data.Daily.PrecipitationSum, i),
			PrecipProb: safeIdxInt(data.Daily.PrecipitationProbabilityMax, i),
			WindMax:    safeIdx(data.Daily.WindSpeed10mMax, i),
			GustsMax:   safeIdx(data.Daily.WindGusts10mMax, i),
			Sunrise:    safeIdxStr(data.Daily.Sunrise, i),
			Sunset:     safeIdxStr(data.Daily.Sunset, i),
			UV:         safeIdxFloatPtr(data.Daily.UvIndexMax, i),
			Meta: weatherMeta{
				Desc:  dw.Desc,
				Icon:  dw.Icon,
				Group: dw.Group,
			},
		})
	}
	return out
}

func normalizeMetNo(data metNoResponse) normalizedWeather {
	var out normalizedWeather
	out.Timezone = "UTC"
	if len(data.Geometry.Coordinates) >= 3 {
		out.Elevation = ptrFloat64(data.Geometry.Coordinates[2])
	}
	if len(data.Properties.Timeseries) == 0 {
		return out
	}

	current := data.Properties.Timeseries[0]
	currentMeta := metNoMeta(current)
	cloud := int(math.Round(current.Data.Instant.Details.CloudAreaFraction))
	deg := current.Data.Instant.Details.WindFromDirection
	out.Current = normalizedCurrent{
		Temp:       current.Data.Instant.Details.AirTemperature,
		FeelsLike:  current.Data.Instant.Details.AirTemperature,
		Humidity:   int(math.Round(current.Data.Instant.Details.RelativeHumidity)),
		Precip:     current.Data.Next1Hours.Details.PrecipitationAmount,
		Pressure:   ptrFloat64(current.Data.Instant.Details.AirPressureAtSeaLevel),
		WindSpeed:  msToKn(current.Data.Instant.Details.WindSpeed),
		WindGusts:  msToKn(current.Data.Instant.Details.WindSpeed),
		WindDir:    windDirLabel(&deg),
		WindDeg:    ptrFloat64(deg),
		CloudCover: ptrInt(cloud),
		IsDay:      boolToDayInt(strings.Contains(currentMeta.Icon, "day")),
		Meta:       currentMeta,
	}

	forecastByDate := map[string]*normalizedForecast{}
	dateOrder := make([]string, 0, 7)
	for idx, slot := range data.Properties.Timeseries {
		meta := metNoMeta(slot)
		details := slot.Data.Instant.Details
		knots := msToKn(details.WindSpeed)
		timeStr := slot.Time
		if idx < 24 {
			out.Hourly = append(out.Hourly, normalizedHourly{
				Time:       timeStr,
				Temp:       details.AirTemperature,
				PrecipProb: metNoPrecipProb(slot),
				Wind:       knots,
				Gusts:      knots,
				Meta:       meta,
			})
		}
		date := dateOnly(timeStr)
		if _, ok := forecastByDate[date]; !ok {
			forecastByDate[date] = &normalizedForecast{
				Date:     date,
				High:     details.AirTemperature,
				Low:      details.AirTemperature,
				Meta:     meta,
				WindMax:  knots,
				GustsMax: knots,
			}
			dateOrder = append(dateOrder, date)
		}
		day := forecastByDate[date]
		day.High = math.Max(day.High, details.AirTemperature)
		day.Low = math.Min(day.Low, details.AirTemperature)
		day.Precip += slot.Data.Next1Hours.Details.PrecipitationAmount
		day.PrecipProb = max(day.PrecipProb, metNoPrecipProb(slot))
		day.WindMax = math.Max(day.WindMax, knots)
		day.GustsMax = math.Max(day.GustsMax, knots)
		if preferForecastMeta(slot.Time, day.Meta, meta) {
			day.Meta = meta
		}
	}
	for _, date := range dateOrder {
		if len(out.Forecast) >= 7 {
			break
		}
		out.Forecast = append(out.Forecast, *forecastByDate[date])
	}
	return out
}

func normalizeNWS(data struct {
	Points nwsPointsResponse
	Hourly nwsForecastResponse
	Daily  nwsForecastResponse
}) normalizedWeather {
	out := normalizedWeather{
		Timezone: data.Points.Properties.TimeZone,
	}
	if len(data.Hourly.Properties.Periods) == 0 {
		return out
	}

	first := data.Hourly.Properties.Periods[0]
	currentMeta := nwsMeta(first.ShortForecast, first.IsDaytime)
	windKn := mphToKn(parseWindSpeedMPH(first.WindSpeed))
	gustKn := windKn
	if g := parseMaxGustMPH(first.DetailedForecast); g > 0 {
		gustKn = mphToKn(g)
	}
	cloud := nwsCloudCover(first.ShortForecast)
	deg := cardinalToDegrees(first.WindDirection)
	out.Current = normalizedCurrent{
		Temp:       toCelsius(float64(first.Temperature), first.TemperatureUnit),
		FeelsLike:  toCelsius(float64(first.Temperature), first.TemperatureUnit),
		Humidity:   int(math.Round(derefFloat(first.RelativeHumidity.Value))),
		Precip:     0,
		WindSpeed:  windKn,
		WindGusts:  maxFloat(gustKn, windKn),
		WindDir:    first.WindDirection,
		WindDeg:    deg,
		CloudCover: ptrInt(cloud),
		IsDay:      boolToDayInt(first.IsDaytime),
		Meta:       currentMeta,
	}

	for i, p := range data.Hourly.Properties.Periods {
		if i >= 24 {
			break
		}
		meta := nwsMeta(p.ShortForecast, p.IsDaytime)
		wind := mphToKn(parseWindSpeedMPH(p.WindSpeed))
		gust := wind
		if g := parseMaxGustMPH(p.DetailedForecast); g > 0 {
			gust = mphToKn(g)
		}
		out.Hourly = append(out.Hourly, normalizedHourly{
			Time:       p.StartTime,
			Temp:       toCelsius(float64(p.Temperature), p.TemperatureUnit),
			PrecipProb: int(math.Round(derefFloat(p.ProbabilityOfPrecipitation.Value))),
			Wind:       wind,
			Gusts:      maxFloat(gust, wind),
			Meta:       meta,
		})
	}

	forecast := aggregateNWSDaily(data)
	if len(forecast) > 0 {
		forecast[0].Sunrise = data.Points.Properties.Astronomical.Sunrise
		forecast[0].Sunset = data.Points.Properties.Astronomical.Sunset
		forecast[0].CivilDawn = data.Points.Properties.Astronomical.CivilTwilightBegin
		forecast[0].CivilDusk = data.Points.Properties.Astronomical.CivilTwilightEnd
	}
	out.Forecast = forecast
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

func safeIdxPtr(s []float64, i int) *float64 {
	if i < len(s) {
		return ptrFloat64(s[i])
	}
	return nil
}

func safeIdxFloatPtr(s []float64, i int) *float64 {
	if i < len(s) {
		return ptrFloat64(s[i])
	}
	return nil
}

func ptrFloat64(v float64) *float64 { return &v }

func ptrInt(v int) *int { return &v }

func derefFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func derefInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

func pressureInHg(v *float64) interface{} {
	if v == nil {
		return nil
	}
	return hpaToInhg(*v)
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

func metNoMeta(slot struct {
	Time string `json:"time"`
	Data struct {
		Instant struct {
			Details struct {
				AirPressureAtSeaLevel float64 `json:"air_pressure_at_sea_level"`
				AirTemperature        float64 `json:"air_temperature"`
				CloudAreaFraction     float64 `json:"cloud_area_fraction"`
				RelativeHumidity      float64 `json:"relative_humidity"`
				WindFromDirection     float64 `json:"wind_from_direction"`
				WindSpeed             float64 `json:"wind_speed"`
			} `json:"details"`
		} `json:"instant"`
		Next1Hours struct {
			Summary struct {
				SymbolCode string `json:"symbol_code"`
			} `json:"summary"`
			Details struct {
				PrecipitationAmount float64 `json:"precipitation_amount"`
			} `json:"details"`
		} `json:"next_1_hours"`
		Next6Hours struct {
			Summary struct {
				SymbolCode string `json:"symbol_code"`
			} `json:"summary"`
			Details struct {
				PrecipitationAmount float64 `json:"precipitation_amount"`
			} `json:"details"`
		} `json:"next_6_hours"`
	} `json:"data"`
}) weatherMeta {
	symbol := slot.Data.Next1Hours.Summary.SymbolCode
	if symbol == "" {
		symbol = slot.Data.Next6Hours.Summary.SymbolCode
	}
	return weatherMetaFromText(strings.ReplaceAll(symbol, "_", " "), strings.Contains(symbol, "_day"))
}

func metNoPrecipProb(slot struct {
	Time string `json:"time"`
	Data struct {
		Instant struct {
			Details struct {
				AirPressureAtSeaLevel float64 `json:"air_pressure_at_sea_level"`
				AirTemperature        float64 `json:"air_temperature"`
				CloudAreaFraction     float64 `json:"cloud_area_fraction"`
				RelativeHumidity      float64 `json:"relative_humidity"`
				WindFromDirection     float64 `json:"wind_from_direction"`
				WindSpeed             float64 `json:"wind_speed"`
			} `json:"details"`
		} `json:"instant"`
		Next1Hours struct {
			Summary struct {
				SymbolCode string `json:"symbol_code"`
			} `json:"summary"`
			Details struct {
				PrecipitationAmount float64 `json:"precipitation_amount"`
			} `json:"details"`
		} `json:"next_1_hours"`
		Next6Hours struct {
			Summary struct {
				SymbolCode string `json:"symbol_code"`
			} `json:"summary"`
			Details struct {
				PrecipitationAmount float64 `json:"precipitation_amount"`
			} `json:"details"`
		} `json:"next_6_hours"`
	} `json:"data"`
}) int {
	if slot.Data.Next1Hours.Details.PrecipitationAmount > 0 {
		return 100
	}
	if slot.Data.Next6Hours.Details.PrecipitationAmount > 0 {
		return 70
	}
	return 0
}

func weatherMetaFromText(text string, isDay bool) weatherMeta {
	s := strings.ToLower(text)
	switch {
	case strings.Contains(s, "thunder"):
		return weatherMeta{Desc: titleWeather(text), Icon: "wi-thunderstorm", Group: "storm"}
	case strings.Contains(s, "snow"), strings.Contains(s, "sleet"), strings.Contains(s, "ice"):
		return weatherMeta{Desc: titleWeather(text), Icon: "wi-snow", Group: "snow"}
	case strings.Contains(s, "rain"), strings.Contains(s, "drizzle"), strings.Contains(s, "shower"):
		icon := "wi-rain"
		if isDay {
			icon = "wi-day-rain"
		}
		return weatherMeta{Desc: titleWeather(text), Icon: icon, Group: "rain"}
	case strings.Contains(s, "fog"), strings.Contains(s, "mist"), strings.Contains(s, "haze"):
		return weatherMeta{Desc: titleWeather(text), Icon: "wi-fog", Group: "fog"}
	case strings.Contains(s, "partly"), strings.Contains(s, "fair"), strings.Contains(s, "few clouds"):
		icon := "wi-cloudy"
		if isDay {
			icon = "wi-day-cloudy"
		} else {
			icon = "wi-night-alt-cloudy"
		}
		return weatherMeta{Desc: titleWeather(text), Icon: icon, Group: "cloudy"}
	case strings.Contains(s, "cloud"):
		return weatherMeta{Desc: titleWeather(text), Icon: "wi-cloudy", Group: "cloudy"}
	default:
		icon := "wi-day-sunny"
		if !isDay {
			icon = "wi-night-clear"
		}
		return weatherMeta{Desc: titleWeather(text), Icon: icon, Group: "clear"}
	}
}

func titleWeather(text string) string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "_", " "))
	if text == "" {
		return "Clear"
	}
	return strings.Title(text) //nolint:staticcheck // UI label; adequate here
}

func boolToDayInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func msToKn(v float64) float64 { return v * 1.94384449 }

func mphToKn(v float64) float64 { return v * 0.868976242 }

func toCelsius(v float64, unit string) float64 {
	if strings.EqualFold(unit, "F") {
		return (v - 32) * 5 / 9
	}
	return v
}

func dateOnly(ts string) string {
	if len(ts) >= 10 {
		return ts[:10]
	}
	return ts
}

func preferForecastMeta(timeStr string, current, candidate weatherMeta) bool {
	if current.Desc == "" {
		return true
	}
	return strings.Contains(timeStr, "12:") || strings.Contains(timeStr, "13:")
}

var mphRE = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*mph`)
var gustRE = regexp.MustCompile(`gusts? as high as (\d+(?:\.\d+)?)\s*mph`)

func parseWindSpeedMPH(s string) float64 {
	matches := mphRE.FindAllStringSubmatch(strings.ToLower(s), -1)
	maxVal := 0.0
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			maxVal = math.Max(maxVal, v)
		}
	}
	return maxVal
}

func parseMaxGustMPH(s string) float64 {
	m := gustRE.FindStringSubmatch(strings.ToLower(s))
	if len(m) < 2 {
		return 0
	}
	v, _ := strconv.ParseFloat(m[1], 64)
	return v
}

func nwsMeta(shortForecast string, isDay bool) weatherMeta {
	return weatherMetaFromText(shortForecast, isDay)
}

func nwsCloudCover(shortForecast string) int {
	s := strings.ToLower(shortForecast)
	switch {
	case strings.Contains(s, "sunny"), strings.Contains(s, "clear"):
		return 0
	case strings.Contains(s, "partly"):
		return 45
	case strings.Contains(s, "mostly"):
		return 70
	case strings.Contains(s, "cloud"):
		return 90
	default:
		return 50
	}
}

func cardinalToDegrees(dir string) *float64 {
	switch strings.ToUpper(strings.TrimSpace(dir)) {
	case "N":
		return ptrFloat64(0)
	case "NNE":
		return ptrFloat64(22.5)
	case "NE":
		return ptrFloat64(45)
	case "ENE":
		return ptrFloat64(67.5)
	case "E":
		return ptrFloat64(90)
	case "ESE":
		return ptrFloat64(112.5)
	case "SE":
		return ptrFloat64(135)
	case "SSE":
		return ptrFloat64(157.5)
	case "S":
		return ptrFloat64(180)
	case "SSW":
		return ptrFloat64(202.5)
	case "SW":
		return ptrFloat64(225)
	case "WSW":
		return ptrFloat64(247.5)
	case "W":
		return ptrFloat64(270)
	case "WNW":
		return ptrFloat64(292.5)
	case "NW":
		return ptrFloat64(315)
	case "NNW":
		return ptrFloat64(337.5)
	default:
		return nil
	}
}

func aggregateNWSDaily(data struct {
	Points nwsPointsResponse
	Hourly nwsForecastResponse
	Daily  nwsForecastResponse
}) []normalizedForecast {
	byDate := map[string]*normalizedForecast{}
	order := make([]string, 0, 7)
	for _, p := range data.Daily.Properties.Periods {
		date := dateOnly(p.StartTime)
		day, ok := byDate[date]
		if !ok {
			day = &normalizedForecast{
				Date: date,
				High: math.Inf(-1),
				Low:  math.Inf(1),
			}
			byDate[date] = day
			order = append(order, date)
		}
		tempC := toCelsius(float64(p.Temperature), p.TemperatureUnit)
		if p.IsDaytime {
			day.High = math.Max(day.High, tempC)
		} else {
			day.Low = math.Min(day.Low, tempC)
		}
		windKn := mphToKn(parseWindSpeedMPH(p.WindSpeed))
		day.WindMax = math.Max(day.WindMax, windKn)
		gustKn := mphToKn(parseMaxGustMPH(p.DetailedForecast))
		day.GustsMax = math.Max(day.GustsMax, maxFloat(gustKn, windKn))
		day.PrecipProb = max(day.PrecipProb, int(math.Round(derefFloat(p.ProbabilityOfPrecipitation.Value))))
		if day.Meta.Desc == "" || p.IsDaytime {
			day.Meta = nwsMeta(p.ShortForecast, p.IsDaytime)
		}
	}
	out := make([]normalizedForecast, 0, len(order))
	sort.Strings(order)
	for _, date := range order {
		if len(out) >= 7 {
			break
		}
		day := byDate[date]
		if math.IsInf(day.High, -1) {
			day.High = 0
		}
		if math.IsInf(day.Low, 1) {
			day.Low = day.High
		}
		out = append(out, *day)
	}
	return out
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
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
