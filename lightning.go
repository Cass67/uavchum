package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Strike buffer ─────────────────────────────────────────────────────────────

type strike struct {
	lat float64
	lon float64
	ts  float64 // Unix seconds
}

const (
	strikeMaxAge    = 30 * 60 // 30 minutes in seconds
	strikeMaxBuffer = 100_000
	earthNm         = 3440.065
)

var (
	strikes         []strike
	strikeMu        sync.Mutex
	blitzortungConn bool

	blitzortungURLs = []string{
		"wss://ws1.blitzortung.org:3000/",
		"wss://ws5.blitzortung.org:3000/",
		"wss://ws7.blitzortung.org:3000/",
	}
)

func blitzortungThread() {
	urlIdx := 0
	reconnectDelay := 5 * time.Second

	for {
		url := blitzortungURLs[urlIdx%len(blitzortungURLs)]
		didConnect := false

		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			logger.Warn("Blitzortung dial failed", "url", url, "err", err)
			strikeMu.Lock()
			blitzortungConn = false
			strikeMu.Unlock()
		} else {
			didConnect = true
			strikeMu.Lock()
			blitzortungConn = true
			strikeMu.Unlock()
			logger.Info("Blitzortung connected", "url", url)

			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					logger.Warn("Blitzortung disconnected", "err", err)
					strikeMu.Lock()
					blitzortungConn = false
					strikeMu.Unlock()
					break
				}
				var d struct {
					Lat  *float64 `json:"lat"`
					Lon  *float64 `json:"lon"`
					Time *int64   `json:"time"` // nanoseconds
				}
				if err := json.Unmarshal(msg, &d); err != nil || d.Lat == nil || d.Lon == nil || d.Time == nil {
					continue
				}
				s := strike{
					lat: *d.Lat,
					lon: *d.Lon,
					ts:  float64(*d.Time) / 1_000_000_000,
				}
				strikeMu.Lock()
				strikes = append(strikes, s)
				if len(strikes) > strikeMaxBuffer {
					strikes = strikes[len(strikes)-strikeMaxBuffer:]
				}
				strikeMu.Unlock()
			}
			conn.Close() //nolint:errcheck,gosec // G104: connection teardown, error not actionable
		}

		if didConnect {
			reconnectDelay = 5 * time.Second
		} else {
			reconnectDelay *= 2
			if reconnectDelay > 2*time.Minute {
				reconnectDelay = 2 * time.Minute
			}
		}
		urlIdx++
		time.Sleep(reconnectDelay)
	}
}

func haversineNm(lat1, lon1, lat2, lon2 float64) float64 {
	dlat := (lat2 - lat1) * math.Pi / 180
	dlon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dlat/2)*math.Sin(dlat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dlon/2)*math.Sin(dlon/2)
	return earthNm * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// ── Lightning handler ─────────────────────────────────────────────────────────

func handleLightning(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil || !validLat(lat) || !validLon(lon) {
		jsonError(w, "valid lat/lon required", http.StatusBadRequest)
		return
	}

	radiusNm := 150.0
	if rStr := r.URL.Query().Get("radius_nm"); rStr != "" {
		if v, err := strconv.ParseFloat(rStr, 64); err == nil {
			if v < 10 {
				v = 10
			} else if v > 300 {
				v = 300
			}
			radiusNm = v
		}
	}

	cutoff := float64(time.Now().Unix()) - strikeMaxAge
	now := float64(time.Now().Unix())

	strikeMu.Lock()
	snapshot := make([]strike, len(strikes))
	copy(snapshot, strikes)
	connected := blitzortungConn
	strikeMu.Unlock()

	type outStrike struct {
		Lat  float64 `json:"lat"`
		Lon  float64 `json:"lon"`
		AgeS int     `json:"age_s"`
	}

	var nearby []outStrike
	var nearestNm *float64

	for _, s := range snapshot {
		if s.ts < cutoff {
			continue
		}
		d := haversineNm(lat, lon, s.lat, s.lon)
		if d <= radiusNm {
			ageS := int(now - s.ts)
			nearby = append(nearby, outStrike{
				Lat:  math.Round(s.lat*10000) / 10000,
				Lon:  math.Round(s.lon*10000) / 10000,
				AgeS: ageS,
			})
			if nearestNm == nil || d < *nearestNm {
				rounded := math.Round(d*10) / 10
				nearestNm = &rounded
			}
		}
	}

	// Sort by age ascending (youngest first)
	sort.Slice(nearby, func(i, j int) bool { return nearby[i].AgeS < nearby[j].AgeS })
	if len(nearby) > 500 {
		nearby = nearby[:500]
	}
	if nearby == nil {
		nearby = []outStrike{}
	}

	jsonOK(w, map[string]interface{}{
		"strikes":    nearby,
		"count":      len(nearby),
		"nearest_nm": nearestNm,
		"connected":  connected,
	})
}
