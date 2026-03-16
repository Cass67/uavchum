package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"strings"
	"sync"
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

	// Fan out all upstream calls concurrently — none depend on each other at fetch time.
	var (
		rawMetar   interface{}
		rawTAF     interface{}
		rawSigmet  interface{}
		rawPireps  interface{}
		notams     []map[string]string
		notamExtra map[string]interface{}
	)

	var wg sync.WaitGroup
	wg.Add(5)

	go func() {
		defer wg.Done()
		rawMetar = fetchJSON(r, "https://aviationweather.gov/api/data/metar", map[string]string{
			"ids": station, "format": "json", "hours": "6",
		})
	}()

	go func() {
		defer wg.Done()
		rawTAF = fetchJSON(r, "https://aviationweather.gov/api/data/taf", map[string]string{
			"ids": station, "format": "json",
		})
	}()

	go func() {
		defer wg.Done()
		rawSigmet = fetchJSON(r, "https://aviationweather.gov/api/data/airsigmet", map[string]string{
			"format": "json",
		})
	}()

	go func() {
		defer wg.Done()
		rawPireps = fetchJSON(r, "https://aviationweather.gov/api/data/pirep", map[string]string{
			"id": station, "format": "json", "distance": "100", "age": "3",
		})
	}()

	go func() {
		defer wg.Done()
		notams, notamExtra = fetchNotams(r, station)
	}()

	wg.Wait()

	result := map[string]interface{}{
		"station":       station,
		"metar":         []interface{}{},
		"metar_decoded": nil,
		"taf":           []interface{}{},
		"airsigmet":     []interface{}{},
		"pireps":        []interface{}{},
		"notams":        []interface{}{},
	}

	// METAR — decode for lat/lon used by SIGMET filtering below.
	var metarDecoded *MetarDecoded
	if rawMetar != nil {
		result["metar"] = rawMetar
		var metars []metarJSON
		if json.Unmarshal(mustMarshal(rawMetar), &metars) == nil && len(metars) > 0 {
			dec := decodeMetar(metars[0])
			metarDecoded = &dec
			result["metar_decoded"] = dec
		}
	}

	if rawTAF != nil {
		result["taf"] = rawTAF
	}

	// SIGMET — filter to nearby coords when available.
	if rawSigmet != nil {
		if metarDecoded != nil && metarDecoded.Lat != nil && metarDecoded.Lon != nil {
			result["airsigmet"] = filterAirsigmets(rawSigmet, *metarDecoded.Lat, *metarDecoded.Lon)
		} else {
			if arr, ok := rawSigmet.([]interface{}); ok && len(arr) > 20 {
				result["airsigmet"] = arr[:20]
			} else {
				result["airsigmet"] = rawSigmet
			}
		}
	}

	if rawPireps != nil {
		if arr, ok := rawPireps.([]interface{}); ok && len(arr) > 20 {
			result["pireps"] = arr[:20]
		} else {
			result["pireps"] = rawPireps
		}
	}

	result["notams"] = notams
	for k, v := range notamExtra {
		result[k] = v
	}

	jsonOK(w, result)
}

// fetchNotams tries NAV Canada → ANB → XML fallback.
// Returns the notam list and a map of extra fields to merge into the handler result.
func fetchNotams(r *http.Request, station string) ([]map[string]string, map[string]interface{}) {
	extra := map[string]interface{}{}
	var notams []map[string]string

	// NAV Canada (CY** airports)
	if strings.HasPrefix(station, "C") {
		req, err := http.NewRequestWithContext(r.Context(), "GET",
			"https://plan.navcanada.ca/weather/api/alpha/", nil)
		if err == nil {
			req.Header.Set("User-Agent", "UAVChum/1.0")
			q := req.URL.Query()
			q.Set("site", station)
			q.Set("alpha", "notam")
			req.URL.RawQuery = q.Encode()

			if resp, doErr := httpClient.Do(req); doErr == nil {
				if resp.StatusCode == http.StatusOK {
					var body struct {
						Data []struct {
							Type string `json:"type"`
							Text string `json:"text"`
						} `json:"data"`
					}
					decErr := json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(&body)
					resp.Body.Close()
					if decErr == nil {
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
							extra["notam_source"] = "NAV CANADA"
							return notams, extra
						}
					}
				} else {
					resp.Body.Close()
				}
			}
		}
	}

	// ANB Data (global, no auth)
	if len(notams) == 0 {
		req, err := http.NewRequestWithContext(r.Context(), "GET",
			"https://api.anbdata.com/anb/states/notams/notams-list", nil)
		if err == nil {
			req.Header.Set("User-Agent", "UAVChum/1.0")
			q := req.URL.Query()
			q.Set("client_id", "test")
			q.Set("icao_location", station)
			req.URL.RawQuery = q.Encode()

			if resp, doErr := httpClient.Do(req); doErr == nil {
				if resp.StatusCode == http.StatusOK {
					var anbList []struct {
						Location string `json:"location"`
						All      string `json:"all"`
						Message  string `json:"message"`
					}
					decErr := json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(&anbList)
					resp.Body.Close()
					if decErr == nil {
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
							extra["notam_source"] = "ANB"
							return notams, extra
						}
					}
				} else {
					resp.Body.Close()
				}
			}
		}
	}

	// XML fallback — aviationweather.gov SIGMET/AIRMET data
	if len(notams) == 0 {
		req, err := http.NewRequestWithContext(r.Context(), "GET",
			"https://aviationweather.gov/api/data/dataserver", nil)
		if err == nil {
			q := req.URL.Query()
			q.Set("requestType", "retrieve")
			q.Set("dataSource", "airsigmets")
			q.Set("stationString", station)
			q.Set("hoursBeforeNow", "24")
			q.Set("format", "xml")
			req.URL.RawQuery = q.Encode()

			if resp, doErr := httpClient.Do(req); doErr == nil {
				if resp.StatusCode == http.StatusOK {
					body, _ := io.ReadAll(io.LimitReader(resp.Body, 500_000))
					resp.Body.Close()
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
				} else {
					resp.Body.Close()
				}
			}
		}
	}

	if len(notams) == 0 {
		portalURL, portalLabel := notamPortal(station)
		extra["notam_source"] = "unavailable"
		extra["notam_portal_url"] = portalURL
		extra["notam_portal_label"] = portalLabel
		extra["notams_note"] = "No keyless NOTAM API is available for this region. " +
			"View live NOTAMs at " + portalLabel + "."
	}

	return notams, extra
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

// fetchJSON does a GET with query params, decodes JSON, returns nil on any error.
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
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&v); err != nil {
		return nil
	}
	return v
}

func mustMarshal(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
}
