package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

func handleAdsb(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil || !validLat(lat) || !validLon(lon) {
		jsonError(w, "valid lat/lon required", http.StatusBadRequest)
		return
	}

	const radiusNm = 150
	rlat := math.Round(lat*10000) / 10000
	rlon := math.Round(lon*10000) / 10000

	// All URL hosts are static; path parameters are bounded validated numerics only.
	// rlat ∈ [-90,90], rlon ∈ [-180,180], radiusNm is a fixed constant.
	//nolint:gosec // G107: URL hosts are hardcoded; path uses pre-validated float64 values — no SSRF
	urls := []string{
		fmt.Sprintf("https://api.adsb.lol/v2/lat/%v/lon/%v/dist/%d", rlat, rlon, radiusNm),
		fmt.Sprintf("https://api.airplanes.live/v2/point/%v/%v/%d", rlat, rlon, radiusNm),
		fmt.Sprintf("https://opendata.adsb.fi/api/v3/lat/%v/lon/%v/dist/%d", rlat, rlon, radiusNm),
	}

	ua := "UAVChum/1.0 (uavchum.app)"
	var raw map[string]interface{}
	for _, url := range urls {
		req, err := http.NewRequestWithContext(r.Context(), "GET", url, nil) //nolint:gosec // G107: see above
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", ua)
		resp, err := httpClient.Do(req)
		if err != nil {
			logger.Warn("ADS-B source failed", "url", url, "err", err)
			continue
		}
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&raw) == nil
		resp.Body.Close()
		if ok {
			break
		}
	}

	if raw == nil {
		jsonOK(w, map[string]interface{}{"aircraft": []interface{}{}, "count": 0})
		return
	}

	var aircraft []map[string]interface{}
	acList, _ := raw["ac"].([]interface{})
	for _, item := range acList {
		ac, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if ac["lat"] == nil || ac["lon"] == nil {
			continue
		}

		var altM interface{}
		altBaro := ac["alt_baro"]
		if v, ok := altBaro.(float64); ok {
			altM = math.Round(v/3.28084*10) / 10
		}

		var velocityMs interface{}
		if gs, ok := ac["gs"].(float64); ok {
			velocityMs = math.Round(gs*0.514444*10) / 10
		}

		onGround := false
		if s, ok := altBaro.(string); ok && s == "ground" {
			onGround = true
		}

		aircraft = append(aircraft, map[string]interface{}{
			"icao24":       getString(ac, "hex"),
			"callsign":     strings.TrimSpace(getString(ac, "flight")),
			"lat":          ac["lat"],
			"lon":          ac["lon"],
			"alt_m":        altM,
			"on_ground":    onGround,
			"velocity_ms":  velocityMs,
			"heading":      ac["track"],
			"registration": strings.TrimSpace(getString(ac, "r")),
			"ac_type":      strings.TrimSpace(getString(ac, "t")),
			"squawk":       strings.TrimSpace(getString(ac, "squawk")),
			"baro_rate":    ac["baro_rate"],
		})
	}

	if aircraft == nil {
		aircraft = []map[string]interface{}{}
	}
	jsonOK(w, map[string]interface{}{"aircraft": aircraft, "count": len(aircraft)})
}

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}
