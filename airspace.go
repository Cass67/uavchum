package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── OpenAIP Cache ─────────────────────────────────────────────────────────────

const openaipTTL = 24 * time.Hour

type openaipEntry struct {
	data interface{}
	ts   time.Time
}

var (
	openaipCache sync.Map // key: country code (lowercase) → openaipEntry
	// Country-from-latlon: coarse 1° grid reverse geocode cache
	countryCache sync.Map // key: "lat,lon" → string country code
)

// ccLowerRE matches exactly two lowercase ASCII letters — guards URL path construction below.
var ccLowerRE = regexp.MustCompile(`^[a-z]{2}$`)

func fetchOpenAIP(ctx *http.Request, cc string) (data interface{}, wasCached bool, ts *int64) {
	cc = strings.ToLower(cc)
	// Re-validate after lowercasing: only two alpha chars may appear in the URL path.
	if !ccLowerRE.MatchString(cc) { //nolint:gosec // G107: URL host is static GCS bucket; only the 2-letter path segment varies
		return nil, false, nil
	}

	now := time.Now()
	if v, ok := openaipCache.Load(cc); ok {
		entry := v.(openaipEntry)
		if now.Sub(entry.ts) < openaipTTL {
			unix := entry.ts.Unix()
			return entry.data, true, &unix
		}
	}

	url := fmt.Sprintf("https://storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f/%s_asp.geojson", cc) //nolint:gosec // G107: see above
	req, err := http.NewRequestWithContext(ctx.Context(), "GET", url, nil)
	if err != nil {
		return nil, false, nil
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, false, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false, nil
	}

	var v interface{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 10*1024*1024)).Decode(&v); err != nil {
		return nil, false, nil
	}
	entry := openaipEntry{data: v, ts: time.Now()}
	openaipCache.Store(cc, entry)
	unix := entry.ts.Unix()
	return v, false, &unix
}

func countryFromLatLon(r *http.Request, lat, lon float64) string {
	key := fmt.Sprintf("%d,%d", int(lat), int(lon))
	if v, ok := countryCache.Load(key); ok {
		return v.(string)
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET",
		"https://nominatim.openstreetmap.org/reverse", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", "UAVChum/1.0 (uavchum.app)")
	q := req.URL.Query()
	q.Set("lat", fmt.Sprintf("%d", int(lat)))
	q.Set("lon", fmt.Sprintf("%d", int(lon)))
	q.Set("format", "json")
	q.Set("zoom", "3")
	req.URL.RawQuery = q.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var body struct {
		Address struct {
			CountryCode string `json:"country_code"`
		} `json:"address"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32*1024)).Decode(&body); err != nil {
		return ""
	}
	cc := strings.ToUpper(body.Address.CountryCode)
	countryCache.Store(key, cc)
	return cc
}

// ── OpenAIP feature filtering ─────────────────────────────────────────────────

var typePrio = map[int]int{
	3: 0, 1: 1, 2: 2, 4: 3, 13: 4, 14: 5, 18: 6,
	28: 7, 5: 8, 7: 8, 26: 9, 21: 10, 6: 10, 0: 11,
}

func filterOpenAIP(data interface{}, lat, lon, delta float64) []interface{} {
	if data == nil {
		return nil
	}
	root, ok := data.(map[string]interface{})
	if !ok {
		return nil
	}
	features, _ := root["features"].([]interface{})

	qMinLon, qMaxLon := lon-delta, lon+delta
	qMinLat, qMaxLat := lat-delta, lat+delta

	type ranked struct {
		prio int
		feat interface{}
	}
	var results []ranked

	for _, f := range features {
		feat, ok := f.(map[string]interface{})
		if !ok {
			continue
		}
		geom, _ := feat["geometry"].(map[string]interface{})
		if geom == nil {
			continue
		}
		bbox := geomBbox(geom)
		if bbox == nil {
			continue
		}
		fMinLon, fMinLat, fMaxLon, fMaxLat := bbox[0], bbox[1], bbox[2], bbox[3]
		if fMaxLon < qMinLon || fMinLon > qMaxLon || fMaxLat < qMinLat || fMinLat > qMaxLat {
			continue
		}

		props, _ := feat["properties"].(map[string]interface{})
		t := 99
		if v, ok := props["type"].(float64); ok {
			t = int(v)
		}

		// Skip floors above FL100 for non-prohibited/restricted
		lower, _ := props["lowerLimit"].(map[string]interface{})
		unit := 1.0
		if u, ok := lower["unit"].(float64); ok {
			unit = u
		}
		val := 0.0
		if v, ok := lower["value"].(float64); ok {
			val = v
		}
		floorFt := val
		if unit == 6 {
			floorFt = val * 100
		}
		if floorFt > 10000 && t != 1 && t != 2 && t != 3 {
			continue
		}

		prio := 99
		if p, ok := typePrio[t]; ok {
			prio = p
		}
		results = append(results, ranked{prio, f})
	}

	// Sort by priority
	for i := 1; i < len(results); i++ {
		for j := i; j > 0 && results[j].prio < results[j-1].prio; j-- {
			results[j], results[j-1] = results[j-1], results[j]
		}
	}

	out := make([]interface{}, 0, min(len(results), 250))
	for i, r := range results {
		if i >= 250 {
			break
		}
		out = append(out, r.feat)
	}
	return out
}

func geomBbox(geom map[string]interface{}) []float64 {
	gt, _ := geom["type"].(string)
	coords := geom["coordinates"]

	var flat [][2]float64
	switch gt {
	case "Point":
		if c, ok := toPoint(coords); ok {
			flat = append(flat, c)
		}
	case "LineString", "MultiPoint":
		flat = toPoints(coords)
	case "Polygon":
		if rings, ok := coords.([]interface{}); ok {
			for _, ring := range rings {
				flat = append(flat, toPoints(ring)...)
			}
		}
	case "MultiPolygon":
		if polys, ok := coords.([]interface{}); ok {
			for _, poly := range polys {
				if rings, ok := poly.([]interface{}); ok {
					for _, ring := range rings {
						flat = append(flat, toPoints(ring)...)
					}
				}
			}
		}
	case "MultiLineString":
		if lines, ok := coords.([]interface{}); ok {
			for _, line := range lines {
				flat = append(flat, toPoints(line)...)
			}
		}
	}

	if len(flat) == 0 {
		return nil
	}
	minLon, minLat := flat[0][0], flat[0][1]
	maxLon, maxLat := flat[0][0], flat[0][1]
	for _, p := range flat[1:] {
		if p[0] < minLon {
			minLon = p[0]
		}
		if p[0] > maxLon {
			maxLon = p[0]
		}
		if p[1] < minLat {
			minLat = p[1]
		}
		if p[1] > maxLat {
			maxLat = p[1]
		}
	}
	return []float64{minLon, minLat, maxLon, maxLat}
}

func toPoint(v interface{}) ([2]float64, bool) {
	arr, ok := v.([]interface{})
	if !ok || len(arr) < 2 {
		return [2]float64{}, false
	}
	lon, ok1 := arr[0].(float64)
	lat, ok2 := arr[1].(float64)
	if !ok1 || !ok2 {
		return [2]float64{}, false
	}
	return [2]float64{lon, lat}, true
}

func toPoints(v interface{}) [][2]float64 {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	var pts [][2]float64
	for _, c := range arr {
		if p, ok := toPoint(c); ok {
			pts = append(pts, p)
		}
	}
	return pts
}

// ── Airspace handler ──────────────────────────────────────────────────────────

func handleAirspace(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil || !validLat(lat) || !validLon(lon) {
		jsonError(w, "valid lat/lon required", http.StatusBadRequest)
		return
	}

	delta := 1.5
	bboxEnv := fmt.Sprintf("%f,%f,%f,%f", lon-delta, lat-delta, lon+delta, lat+delta)

	// Fan out all upstream calls concurrently.
	var (
		rawAirspace interface{}
		rawUASFM    interface{}
		rawTFRs     interface{}
		rawAirports interface{}
	)

	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	needsLookup := !validCountry(country)
	var resolvedCountry string

	goroutines := 4
	if needsLookup {
		goroutines = 5
	}

	var wg sync.WaitGroup
	wg.Add(goroutines)

	go func() {
		defer wg.Done()
		rawAirspace = fetchJSON(r, "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query",
			map[string]string{
				"where":             "CLASS IN ('B','C','D')",
				"geometry":          bboxEnv,
				"geometryType":      "esriGeometryEnvelope",
				"spatialRel":        "esriSpatialRelIntersects",
				"outFields":         "CLASS,NAME,IDENT,LOWER_VAL,UPPER_VAL,LOWER_UOM,UPPER_UOM,LOWER_CODE,UPPER_CODE",
				"f":                 "geojson",
				"resultRecordCount": "100",
			})
	}()

	go func() {
		defer wg.Done()
		rawUASFM = fetchJSON(r, "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_Primary/FeatureServer/0/query",
			map[string]string{
				"where":             "1=1",
				"geometry":          bboxEnv,
				"geometryType":      "esriGeometryEnvelope",
				"spatialRel":        "esriSpatialRelIntersects",
				"outFields":         "CEILING,UNIT,APT1_ICAO,APT1_NAME,AIRSPACE_1",
				"f":                 "geojson",
				"resultRecordCount": "200",
			})
	}()

	go func() {
		defer wg.Done()
		rawTFRs = fetchJSON(r, "https://aviationweather.gov/api/data/tfr",
			map[string]string{"format": "json"})
	}()

	go func() {
		defer wg.Done()
		rawAirports = fetchJSON(r, "https://aviationweather.gov/api/data/metar",
			map[string]string{
				"bbox":   fmt.Sprintf("%f,%f,%f,%f", lat-delta, lon-delta, lat+delta, lon+delta),
				"format": "json",
				"hours":  "2",
			})
	}()

	if needsLookup {
		go func() {
			defer wg.Done()
			resolvedCountry = countryFromLatLon(r, math.Round(lat), math.Round(lon))
		}()
	}

	wg.Wait()

	if needsLookup {
		country = resolvedCountry
	}

	result := map[string]interface{}{
		"airspace": []interface{}{},
		"tfrs":     []interface{}{},
		"uasfm":    []interface{}{},
		"airports": []interface{}{},
	}

	// FAA Class B/C/D
	if rawAirspace != nil {
		if obj, ok := rawAirspace.(map[string]interface{}); ok {
			if features, ok := obj["features"].([]interface{}); ok {
				for _, f := range features {
					if feat, ok := f.(map[string]interface{}); ok {
						props, _ := feat["properties"].(map[string]interface{})
						if props == nil {
							props = map[string]interface{}{}
						}
						if cls, ok := props["CLASS"]; ok {
							props["_class"] = cls
						}
						feat["properties"] = props
					}
				}
				result["airspace"] = features
			}
		}
	}

	// FAA UAS Facility Map (LAANC)
	if rawUASFM != nil {
		if obj, ok := rawUASFM.(map[string]interface{}); ok {
			result["uasfm"] = obj["features"]
		}
	}

	// TFRs
	if rawTFRs != nil {
		if arr, ok := rawTFRs.([]interface{}); ok {
			var nearby []interface{}
			for _, t := range arr {
				obj, ok := t.(map[string]interface{})
				if !ok {
					continue
				}
				tlat := coerceFloat(firstOf(obj, "lat", "latitude"))
				tlon := coerceFloat(firstOf(obj, "lon", "longitude"))
				if tlat == 0 && tlon == 0 {
					nearby = append(nearby, t)
					continue
				}
				if abs64(tlat-lat) < delta+0.5 && abs64(tlon-lon) < delta+0.5 {
					nearby = append(nearby, t)
				}
			}
			if len(nearby) > 20 {
				nearby = nearby[:20]
			}
			result["tfrs"] = nearby
		}
	}

	// Nearby airports
	if rawAirports != nil {
		if arr, ok := rawAirports.([]interface{}); ok {
			seen := map[string]bool{}
			var airports []map[string]interface{}
			for _, m := range arr {
				raw, err := json.Marshal(m)
				if err != nil {
					continue
				}
				var mj metarJSON
				if err := json.Unmarshal(raw, &mj); err != nil {
					continue
				}
				if mj.IcaoId == "" || seen[mj.IcaoId] || mj.Lat == nil || mj.Lon == nil {
					continue
				}
				seen[mj.IcaoId] = true
				dm := decodeMetar(mj)
				airports = append(airports, map[string]interface{}{
					"icao":          mj.IcaoId,
					"name":          mj.Name,
					"lat":           mj.Lat,
					"lon":           mj.Lon,
					"elev":          dm.ElevFt,
					"flight_cat":    dm.FlightCat,
					"wind_dir":      dm.WindDir,
					"wind_speed_kt": dm.WindSpeedKt,
					"wind_gust_kt":  dm.WindGustKt,
					"visibility":    dm.Visibility,
					"temp_c":        dm.TempC,
					"clouds":        dm.Clouds,
					"wx_string":     dm.WxString,
					"raw":           dm.Raw,
					"time":          dm.Time,
				})
				if len(airports) >= 40 {
					break
				}
			}
			result["airports"] = airports
		}
	}

	nowTS := time.Now().Unix()
	sources := []map[string]interface{}{
		{
			"name":     "FAA Controlled Airspace",
			"type":     "Class B / C / D",
			"features": len(toSlice(result["airspace"])),
			"live":     true,
			"ts":       nowTS,
		},
		{
			"name":     "FAA UAS Facility Map",
			"type":     "LAANC drone altitude grids",
			"features": len(toSlice(result["uasfm"])),
			"live":     true,
			"ts":       nowTS,
		},
		{
			"name":     "aviationweather.gov",
			"type":     fmt.Sprintf("TFRs (%d) & airports (%d)", len(toSlice(result["tfrs"])), len(toSlice(result["airports"]))),
			"features": len(toSlice(result["tfrs"])) + len(toSlice(result["airports"])),
			"live":     true,
			"ts":       nowTS,
		},
	}

	if validCountry(country) {
		odata, wasCached, oTS := fetchOpenAIP(r, country)
		openaipFeatures := filterOpenAIP(odata, lat, lon, delta)
		if openaipFeatures == nil {
			openaipFeatures = []interface{}{}
		}
		result["openaip"] = openaipFeatures
		sources = append(sources, map[string]interface{}{
			"name":     "OpenAIP",
			"type":     fmt.Sprintf("Airspace data (%s)", country),
			"features": len(openaipFeatures),
			"live":     !wasCached,
			"ts":       oTS,
		})
	} else {
		result["openaip"] = []interface{}{}
	}

	result["sources"] = sources
	jsonOK(w, result)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func firstOf(m map[string]interface{}, keys ...string) interface{} {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return nil
}

func coerceFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}

func toSlice(v interface{}) []interface{} {
	if v == nil {
		return nil
	}
	s, _ := v.([]interface{})
	return s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
