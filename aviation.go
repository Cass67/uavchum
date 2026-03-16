package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"strings"
)

func notamPortal(station string) (url, label string) {
	s := strings.ToUpper(station)
	switch {
	case strings.HasPrefix(s, "K") || strings.HasPrefix(s, "P"):
		return "https://notams.aim.faa.gov/notamSearch/", "FAA NOTAM Search"
	case strings.HasPrefix(s, "C"):
		return "https://www.navcanada.ca/en/notam.aspx", "NAV CANADA"
	case strings.HasPrefix(s, "EG"):
		return "https://nats-uk.ead-it.com/cms-nats/opencms/en/NOTAM/", "UK AIS NOTAM"
	case s[0] == 'E' || s[0] == 'L' || s[0] == 'B':
		return "https://www.ead.eurocontrol.int/", "EUROCONTROL EAD"
	case strings.HasPrefix(s, "Y"):
		return "https://www.airservicesaustralia.com/naips/", "NAIPS Australia"
	case strings.HasPrefix(s, "NZ"):
		return "https://aip.airways.co.nz/", "Airways NZ"
	default:
		return "https://www.icao.int/safety/airnavigation/NOTAM/", "ICAO NOTAM"
	}
}

func handleAviation(w http.ResponseWriter, r *http.Request) {
	station := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("station")))
	if !validStation(station) {
		jsonError(w, "valid ICAO station code required (3-4 alphanumeric)", http.StatusBadRequest)
		return
	}

	result := map[string]interface{}{
		"station":       station,
		"metar":         []interface{}{},
		"metar_decoded": nil,
		"taf":           []interface{}{},
		"airsigmet":     []interface{}{},
		"pireps":        []interface{}{},
		"notams":        []interface{}{},
	}

	// METAR
	var metarDecoded *MetarDecoded
	if raw := fetchJSON(r, "https://aviationweather.gov/api/data/metar", map[string]string{
		"ids": station, "format": "json", "hours": "6",
	}); raw != nil {
		result["metar"] = raw
		// decode first METAR
		var metars []metarJSON
		if json.Unmarshal(mustMarshal(raw), &metars) == nil && len(metars) > 0 {
			dec := decodeMetar(metars[0])
			metarDecoded = &dec
			result["metar_decoded"] = dec
		}
	}

	// TAF
	if raw := fetchJSON(r, "https://aviationweather.gov/api/data/taf", map[string]string{
		"ids": station, "format": "json",
	}); raw != nil {
		result["taf"] = raw
	}

	// SIGMET/AIRMET — filter to nearby coords if we have a decoded METAR
	if raw := fetchJSON(r, "https://aviationweather.gov/api/data/airsigmet", map[string]string{
		"format": "json",
	}); raw != nil {
		if metarDecoded != nil && metarDecoded.Lat != nil && metarDecoded.Lon != nil {
			slat := *metarDecoded.Lat
			slon := *metarDecoded.Lon
			result["airsigmet"] = filterAirsigmets(raw, slat, slon)
		} else {
			if arr, ok := raw.([]interface{}); ok && len(arr) > 20 {
				result["airsigmet"] = arr[:20]
			} else {
				result["airsigmet"] = raw
			}
		}
	}

	// PIREPs
	if raw := fetchJSON(r, "https://aviationweather.gov/api/data/pirep", map[string]string{
		"id": station, "format": "json", "distance": "100", "age": "3",
	}); raw != nil {
		if arr, ok := raw.([]interface{}); ok && len(arr) > 20 {
			result["pireps"] = arr[:20]
		} else {
			result["pireps"] = raw
		}
	}

	// NOTAMs
	notams := fetchNotams(r, station, result)
	result["notams"] = notams

	jsonOK(w, result)
}

// fetchNotams tries NAV Canada → ANB → XML fallback, populating notam_source.
func fetchNotams(r *http.Request, station string, result map[string]interface{}) []map[string]string {
	var notams []map[string]string

	// NAV Canada (CY** airports)
	if strings.HasPrefix(station, "C") {
		req, _ := http.NewRequestWithContext(r.Context(), "GET",
			"https://plan.navcanada.ca/weather/api/alpha/", nil)
		req.Header.Set("User-Agent", "UAVChum/1.0")
		q := req.URL.Query()
		q.Set("site", station)
		q.Set("alpha", "notam")
		req.URL.RawQuery = q.Encode()

		if resp, err := httpClient.Do(req); err == nil {
			defer resp.Body.Close()
			var body struct {
				Data []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"data"`
			}
			if json.NewDecoder(resp.Body).Decode(&body) == nil {
				for _, item := range body.Data {
					if item.Type != "notam" {
						continue
					}
					raw := item.Text
					var payload struct {
						Raw string `json:"raw"`
					}
					if json.Unmarshal([]byte(item.Text), &payload) == nil && payload.Raw != "" {
						raw = payload.Raw
					}
					if raw != "" {
						notams = append(notams, map[string]string{"raw": raw, "source": "NAV CANADA"})
					}
				}
				if len(notams) > 60 {
					notams = notams[:60]
				}
				if len(notams) > 0 {
					result["notam_source"] = "NAV CANADA"
					return notams
				}
			}
		}
	}

	// ANB Data (global, no auth)
	if len(notams) == 0 {
		req, _ := http.NewRequestWithContext(r.Context(), "GET",
			"https://api.anbdata.com/anb/states/notams/notams-list", nil)
		req.Header.Set("User-Agent", "UAVChum/1.0")
		q := req.URL.Query()
		q.Set("client_id", "test")
		q.Set("icao_location", station)
		req.URL.RawQuery = q.Encode()

		if resp, err := httpClient.Do(req); err == nil {
			defer resp.Body.Close()
			var anbList []struct {
				Location string `json:"location"`
				All      string `json:"all"`
				Message  string `json:"message"`
			}
			if json.NewDecoder(resp.Body).Decode(&anbList) == nil {
				for _, n := range anbList {
					if strings.ToUpper(n.Location) != station {
						continue
					}
					raw := n.All
					if raw == "" {
						raw = n.Message
					}
					if raw != "" {
						notams = append(notams, map[string]string{"raw": raw, "source": "ANB"})
					}
				}
				if len(notams) > 0 {
					result["notam_source"] = "ANB"
					return notams
				}
			}
		}
	}

	// XML fallback — aviationweather.gov SIGMET/AIRMET data
	if len(notams) == 0 {
		req, _ := http.NewRequestWithContext(r.Context(), "GET",
			"https://aviationweather.gov/api/data/dataserver", nil)
		q := req.URL.Query()
		q.Set("requestType", "retrieve")
		q.Set("dataSource", "airsigmets")
		q.Set("stationString", station)
		q.Set("hoursBeforeNow", "24")
		q.Set("format", "xml")
		req.URL.RawQuery = q.Encode()

		if resp, err := httpClient.Do(req); err == nil {
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 500_000))
			type airsigmet struct {
				RawText string `xml:"raw_text"`
			}
			type xmlRoot struct {
				Items []airsigmet `xml:"data>AIRSIGMET"`
			}
			var root xmlRoot
			if xml.Unmarshal(body, &root) == nil {
				for _, item := range root.Items {
					if item.RawText != "" && strings.Contains(item.RawText, station) {
						notams = append(notams, map[string]string{
							"raw": item.RawText, "source": "AWC SIGMET/AIRMET",
						})
					}
				}
			}
		}
	}

	if len(notams) == 0 {
		portalURL, portalLabel := notamPortal(station)
		result["notam_source"] = "unavailable"
		result["notam_portal_url"] = portalURL
		result["notam_portal_label"] = portalLabel
		result["notams_note"] = "No keyless NOTAM API is available for this region. " +
			"View live NOTAMs at " + portalLabel + "."
	}

	return notams
}

// filterAirsigmets keeps alerts within ~5°lat / 8°lon of the station.
func filterAirsigmets(raw interface{}, slat, slon float64) []interface{} {
	arr, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	var nearby []interface{}
	for _, a := range arr {
		obj, ok := a.(map[string]interface{})
		if !ok {
			continue
		}
		coords, _ := obj["coords"].([]interface{})
		for _, c := range coords {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			clat, _ := cm["lat"].(float64)
			clon, _ := cm["lon"].(float64)
			if abs64(clat-slat) < 5 && abs64(clon-slon) < 8 {
				nearby = append(nearby, a)
				break
			}
		}
	}
	return nearby
}

func abs64(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// fetchJSON does a GET with query params, decodes as JSON, returns nil on error.
func fetchJSON(r *http.Request, url string, params map[string]string) interface{} {
	req, err := http.NewRequestWithContext(r.Context(), "GET", url, nil)
	if err != nil {
		return nil
	}
	q := req.URL.Query()
	for k, v := range params {
		q.Set(k, v)
	}
	req.URL.RawQuery = q.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var v interface{}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return nil
	}
	return v
}

func mustMarshal(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
}
