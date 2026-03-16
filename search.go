package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const searchMax = 200

func handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		jsonOK(w, []interface{}{})
		return
	}
	if len(q) > searchMax {
		jsonError(w, "query too long", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET",
		"https://geocoding-api.open-meteo.com/v1/search", nil)
	if err != nil {
		jsonError(w, "Search unavailable", http.StatusInternalServerError)
		return
	}
	qp := req.URL.Query()
	qp.Set("name", q)
	qp.Set("count", "10")
	qp.Set("language", "en")
	qp.Set("format", "json")
	req.URL.RawQuery = qp.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		jsonError(w, "Search unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close() //nolint:errcheck,gosec // G104: close errors not actionable after body read
	if resp.StatusCode != http.StatusOK {
		jsonError(w, "Search unavailable", http.StatusBadGateway)
		return
	}

	var body struct {
		Results []struct {
			Name        string  `json:"name"`
			Country     string  `json:"country"`
			CountryCode string  `json:"country_code"`
			Admin1      string  `json:"admin1"`
			Latitude    float64 `json:"latitude"`
			Longitude   float64 `json:"longitude"`
			Elevation   float64 `json:"elevation"`
			Population  int     `json:"population"`
			Timezone    string  `json:"timezone"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(&body); err != nil {
		jsonError(w, "Search unavailable", http.StatusBadGateway)
		return
	}

	out := make([]map[string]interface{}, 0, len(body.Results))
	for _, x := range body.Results {
		out = append(out, map[string]interface{}{
			"name":         x.Name,
			"country":      x.Country,
			"country_code": x.CountryCode,
			"admin1":       x.Admin1,
			"lat":          x.Latitude,
			"lon":          x.Longitude,
			"elevation":    x.Elevation,
			"population":   x.Population,
			"timezone":     x.Timezone,
		})
	}
	jsonOK(w, out)
}

func handleStation(w http.ResponseWriter, r *http.Request) {
	station := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("id")))
	if !validStation(station) {
		jsonError(w, "valid ICAO station code required", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET",
		"https://aviationweather.gov/api/data/airport", nil)
	if err != nil {
		jsonError(w, "Station data unavailable", http.StatusInternalServerError)
		return
	}
	q := req.URL.Query()
	q.Set("ids", station)
	q.Set("format", "json")
	req.URL.RawQuery = q.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		jsonError(w, "Station data unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close() //nolint:errcheck,gosec // G104: close errors not actionable after body read
	if resp.StatusCode != http.StatusOK {
		jsonError(w, "Station data unavailable", http.StatusBadGateway)
		return
	}

	var data []json.RawMessage
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&data); err != nil || len(data) == 0 {
		jsonOK(w, map[string]interface{}{})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(data[0]); err != nil {
		logger.Error("station write failed", "err", err)
	}
}

func handleFlightRoute(w http.ResponseWriter, r *http.Request) {
	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))
	if !callsignRE.MatchString(callsign) {
		jsonError(w, "valid callsign required", http.StatusBadRequest)
		return
	}

	// Re-assert validation immediately before URL construction.
	// Host is static (api.adsbdb.com); only path segment varies.
	// callsignRE enforces ^[A-Z0-9]{3,8}$ — no path traversal possible.
	if !callsignRE.MatchString(callsign) { //nolint:gosec // G107: URL host static; path param validated above
		jsonOK(w, map[string]interface{}{"found": false})
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), "GET", //nolint:gosec // G107: see above
		fmt.Sprintf("https://api.adsbdb.com/v0/callsign/%s", callsign), nil)
	if err != nil {
		jsonOK(w, map[string]interface{}{"found": false})
		return
	}
	req.Header.Set("User-Agent", "UAVChum/1.0")

	resp, err := httpClient.Do(req) //nolint:gosec // G704: URL host is static; callsign path param validated against callsignRE above
	if err != nil {
		jsonOK(w, map[string]interface{}{"found": false})
		return
	}
	defer resp.Body.Close() //nolint:errcheck,gosec // G104: close errors not actionable after body read
	if resp.StatusCode != http.StatusOK {
		jsonOK(w, map[string]interface{}{"found": false})
		return
	}

	var body struct {
		Response struct {
			FlightRoute *struct {
				CallsignIata string `json:"callsign_iata"`
				Airline      *struct {
					Name string `json:"name"`
				} `json:"airline"`
				Origin      map[string]interface{} `json:"origin"`
				Destination map[string]interface{} `json:"destination"`
			} `json:"flightroute"`
		} `json:"response"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&body); err != nil || body.Response.FlightRoute == nil {
		jsonOK(w, map[string]interface{}{"found": false})
		return
	}

	route := body.Response.FlightRoute
	airlineName := ""
	if route.Airline != nil {
		airlineName = route.Airline.Name
	}

	jsonOK(w, map[string]interface{}{
		"found":         true,
		"callsign_iata": route.CallsignIata,
		"airline":       airlineName,
		"origin":        formatAirport(route.Origin),
		"destination":   formatAirport(route.Destination),
	})
}

func formatAirport(ap map[string]interface{}) map[string]interface{} {
	if ap == nil {
		return map[string]interface{}{}
	}
	return map[string]interface{}{
		"iata":         getString(ap, "iata_code"),
		"icao":         getString(ap, "icao_code"),
		"name":         getString(ap, "name"),
		"municipality": getString(ap, "municipality"),
		"country":      getString(ap, "country_name"),
	}
}
