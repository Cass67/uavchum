package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHandleWeatherServesFreshCacheWithoutUpstreamCall(t *testing.T) {
	restore := setupWeatherTestState(t)
	defer restore()

	key := weatherCacheKey(51.5072, -0.1276)
	weatherCache.Store(key, weatherCacheEntry{
		body:      []byte(`{"current":{"temp":12.3},"forecast":[],"hourly":[]}`),
		fetchedAt: weatherNow(),
	})

	httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("unexpected upstream call")
		return nil, nil
	})}

	req := httptest.NewRequest(http.MethodGet, "/api/weather?lat=51.5072&lon=-0.1276", nil)
	rec := httptest.NewRecorder()

	handleWeather(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"temp":12.3`)) {
		t.Fatalf("expected cached payload, got %s", rec.Body.String())
	}
}

func TestHandleWeatherFallsBackToStaleCacheOnTransientFailure(t *testing.T) {
	restore := setupWeatherTestState(t)
	defer restore()

	now := time.Date(2026, 4, 7, 11, 0, 0, 0, time.UTC)
	weatherNow = func() time.Time { return now }

	key := weatherCacheKey(51.5072, -0.1276)
	weatherCache.Store(key, weatherCacheEntry{
		body:      []byte(`{"current":{"temp":7.1},"forecast":[],"hourly":[]}`),
		fetchedAt: now.Add(-10 * time.Minute),
	})

	httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusTooManyRequests, `{"error":true,"reason":"Too many concurrent requests"}`), nil
	})}

	req := httptest.NewRequest(http.MethodGet, "/api/weather?lat=51.5072&lon=-0.1276", nil)
	rec := httptest.NewRecorder()

	handleWeather(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"temp":7.1`)) {
		t.Fatalf("expected stale cached payload, got %s", rec.Body.String())
	}
}

func TestHandleWeatherCoalescesConcurrentRequests(t *testing.T) {
	restore := setupWeatherTestState(t)
	defer restore()

	var calls int32
	release := make(chan struct{})
	httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		atomic.AddInt32(&calls, 1)
		<-release
		return jsonResponse(http.StatusOK, sampleOpenMeteoBody), nil
	})}

	req1 := httptest.NewRequest(http.MethodGet, "/api/weather?lat=51.5072&lon=-0.1276", nil)
	req2 := httptest.NewRequest(http.MethodGet, "/api/weather?lat=51.5072&lon=-0.1276", nil)
	rec1 := httptest.NewRecorder()
	rec2 := httptest.NewRecorder()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		handleWeather(rec1, req1)
	}()
	go func() {
		defer wg.Done()
		handleWeather(rec2, req2)
	}()

	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected 1 upstream call, got %d", got)
	}
	if rec1.Code != http.StatusOK || rec2.Code != http.StatusOK {
		t.Fatalf("expected both responses to be 200, got %d and %d", rec1.Code, rec2.Code)
	}
}

func TestHandleWeatherFallsBackToMetNo(t *testing.T) {
	restore := setupWeatherTestState(t)
	defer restore()

	httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case req.URL.Host == "api.open-meteo.com":
			return jsonResponse(http.StatusTooManyRequests, `{"error":true}`), nil
		case req.URL.Host == "api.met.no":
			return jsonResponse(http.StatusOK, sampleMetNoBody), nil
		default:
			t.Fatalf("unexpected upstream URL: %s", req.URL.String())
			return nil, nil
		}
	})}

	req := httptest.NewRequest(http.MethodGet, "/api/weather?lat=51.5072&lon=-0.1276", nil)
	rec := httptest.NewRecorder()
	handleWeather(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"timezone":"UTC"`)) {
		t.Fatalf("expected MET Norway fallback payload, got %s", rec.Body.String())
	}
}

func TestHandleWeatherFallsBackToNWS(t *testing.T) {
	restore := setupWeatherTestState(t)
	defer restore()

	httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case req.URL.Host == "api.open-meteo.com":
			return jsonResponse(http.StatusGatewayTimeout, `{"error":true}`), nil
		case req.URL.Host == "api.met.no":
			return jsonResponse(http.StatusServiceUnavailable, `{"error":true}`), nil
		case req.URL.Host == "api.weather.gov" && req.URL.Path == "/points/38.8894,-77.0352":
			return jsonResponse(http.StatusOK, sampleNWSPointsBody), nil
		case req.URL.Host == "api.weather.gov" && req.URL.Path == "/gridpoints/LWX/97,71/forecast/hourly":
			return jsonResponse(http.StatusOK, sampleNWSHourlyBody), nil
		case req.URL.Host == "api.weather.gov" && req.URL.Path == "/gridpoints/LWX/97,71/forecast":
			return jsonResponse(http.StatusOK, sampleNWSDailyBody), nil
		default:
			t.Fatalf("unexpected upstream URL: %s", req.URL.String())
			return nil, nil
		}
	})}

	req := httptest.NewRequest(http.MethodGet, "/api/weather?lat=38.8894&lon=-77.0352", nil)
	rec := httptest.NewRecorder()
	handleWeather(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"timezone":"America/New_York"`)) {
		t.Fatalf("expected NWS fallback payload, got %s", rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"sunrise":"2026-04-07T06:43:11-04:00"`)) {
		t.Fatalf("expected astronomical data in NWS payload, got %s", rec.Body.String())
	}
}

func setupWeatherTestState(t *testing.T) func() {
	t.Helper()

	origClient := httpClient
	origNow := weatherNow
	origFreshTTL := weatherCacheFreshTTL
	origStaleTTL := weatherCacheStaleTTL
	origRetryDelay := weatherRetryDelay
	origMaxAttempts := weatherMaxAttempts

	clearWeatherSyncMap(&weatherCache)
	clearWeatherSyncMap(&weatherInflight)
	weatherNow = time.Now
	weatherCacheFreshTTL = 5 * time.Minute
	weatherCacheStaleTTL = 30 * time.Minute
	weatherRetryDelay = 0
	weatherMaxAttempts = 1

	return func() {
		httpClient = origClient
		weatherNow = origNow
		weatherCacheFreshTTL = origFreshTTL
		weatherCacheStaleTTL = origStaleTTL
		weatherRetryDelay = origRetryDelay
		weatherMaxAttempts = origMaxAttempts
		clearWeatherSyncMap(&weatherCache)
		clearWeatherSyncMap(&weatherInflight)
	}
}

func clearWeatherSyncMap(m *sync.Map) {
	m.Range(func(key, _ any) bool {
		m.Delete(key)
		return true
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}
}

const sampleOpenMeteoBody = `{
  "current": {
    "temperature_2m": 12.3,
    "relative_humidity_2m": 64,
    "apparent_temperature": 11.0,
    "precipitation": 0,
    "weather_code": 1,
    "wind_speed_10m": 9.5,
    "wind_direction_10m": 180,
    "wind_gusts_10m": 14.2,
    "surface_pressure": 1018.3,
    "cloud_cover": 25,
    "is_day": 1
  },
  "hourly": {
    "time": ["2026-04-07T12:00"],
    "temperature_2m": [12.3],
    "precipitation_probability": [5],
    "weather_code": [1],
    "wind_speed_10m": [9.5],
    "wind_gusts_10m": [14.2],
    "wind_speed_80m": [12.8]
  },
  "daily": {
    "time": ["2026-04-07"],
    "weather_code": [1],
    "temperature_2m_max": [14.8],
    "temperature_2m_min": [8.2],
    "precipitation_sum": [0.1],
    "precipitation_probability_max": [15],
    "wind_speed_10m_max": [12.0],
    "wind_gusts_10m_max": [18.5],
    "sunrise": ["2026-04-07T06:20"],
    "sunset": ["2026-04-07T19:42"],
    "uv_index_max": [4.2]
  },
  "timezone": "Europe/London",
  "elevation": 35.0
}`

const sampleMetNoBody = `{
  "geometry": { "coordinates": [-0.1276, 51.5072, 8] },
  "properties": {
    "timeseries": [
      {
        "time": "2026-04-07T11:00:00Z",
        "data": {
          "instant": {
            "details": {
              "air_pressure_at_sea_level": 1022.8,
              "air_temperature": 16.5,
              "cloud_area_fraction": 0.0,
              "relative_humidity": 47.6,
              "wind_from_direction": 97.6,
              "wind_speed": 4.2
            }
          },
          "next_1_hours": {
            "summary": { "symbol_code": "clearsky_day" },
            "details": { "precipitation_amount": 0.0 }
          },
          "next_6_hours": {
            "summary": { "symbol_code": "clearsky_day" },
            "details": { "precipitation_amount": 0.0 }
          }
        }
      },
      {
        "time": "2026-04-07T12:00:00Z",
        "data": {
          "instant": {
            "details": {
              "air_pressure_at_sea_level": 1022.5,
              "air_temperature": 17.7,
              "cloud_area_fraction": 0.0,
              "relative_humidity": 46.7,
              "wind_from_direction": 101.2,
              "wind_speed": 4.3
            }
          },
          "next_1_hours": {
            "summary": { "symbol_code": "clearsky_day" },
            "details": { "precipitation_amount": 0.0 }
          },
          "next_6_hours": {
            "summary": { "symbol_code": "clearsky_day" },
            "details": { "precipitation_amount": 0.0 }
          }
        }
      }
    ]
  }
}`

const sampleNWSPointsBody = `{
  "properties": {
    "forecast": "https://api.weather.gov/gridpoints/LWX/97,71/forecast",
    "forecastHourly": "https://api.weather.gov/gridpoints/LWX/97,71/forecast/hourly",
    "timeZone": "America/New_York",
    "astronomicalData": {
      "sunrise": "2026-04-07T06:43:11-04:00",
      "sunset": "2026-04-07T19:37:46-04:00",
      "civilTwilightBegin": "2026-04-07T06:17:29-04:00",
      "civilTwilightEnd": "2026-04-07T20:03:28-04:00"
    }
  }
}`

const sampleNWSHourlyBody = `{
  "properties": {
    "periods": [
      {
        "startTime": "2026-04-07T06:00:00-04:00",
        "endTime": "2026-04-07T07:00:00-04:00",
        "isDaytime": true,
        "temperature": 45,
        "temperatureUnit": "F",
        "probabilityOfPrecipitation": { "value": 0 },
        "relativeHumidity": { "value": 68 },
        "windSpeed": "8 mph",
        "windDirection": "NW",
        "shortForecast": "Sunny",
        "detailedForecast": "Sunny."
      }
    ]
  }
}`

const sampleNWSDailyBody = `{
  "properties": {
    "periods": [
      {
        "startTime": "2026-04-07T06:00:00-04:00",
        "endTime": "2026-04-07T18:00:00-04:00",
        "isDaytime": true,
        "temperature": 54,
        "temperatureUnit": "F",
        "probabilityOfPrecipitation": { "value": 0 },
        "windSpeed": "7 to 16 mph",
        "windDirection": "NW",
        "shortForecast": "Sunny",
        "detailedForecast": "Sunny, with gusts as high as 28 mph."
      },
      {
        "startTime": "2026-04-07T18:00:00-04:00",
        "endTime": "2026-04-08T06:00:00-04:00",
        "isDaytime": false,
        "temperature": 33,
        "temperatureUnit": "F",
        "probabilityOfPrecipitation": { "value": 0 },
        "windSpeed": "7 to 13 mph",
        "windDirection": "N",
        "shortForecast": "Mostly Clear",
        "detailedForecast": "Mostly clear."
      }
    ]
  }
}`
