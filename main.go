package main

import (
	"crypto/rand"
	"encoding/base64"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
)

type ctxKey int

const ctxNonce ctxKey = iota

var (
	httpClient *http.Client
	tmpl       *template.Template
	logger     = slog.Default()

	icaoRE     = regexp.MustCompile(`^[A-Z][A-Z0-9]{2,3}$`)
	ccRE       = regexp.MustCompile(`^[A-Z]{2}$`)
	callsignRE = regexp.MustCompile(`^[A-Z0-9]{3,8}$`)
)

func envFlag(name string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if v == "" {
		return def
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func isProduction() bool {
	env := os.Getenv("UAVCHUM_ENV")
	if env == "" {
		env = os.Getenv("FLASK_ENV")
	}
	return strings.ToLower(strings.TrimSpace(env)) == "production"
}

func validLat(v float64) bool    { return v >= -90 && v <= 90 }
func validLon(v float64) bool    { return v >= -180 && v <= 180 }
func validStation(s string) bool { return icaoRE.MatchString(s) }
func validCountry(s string) bool { return ccRE.MatchString(s) }

func newNonce() string {
	b := make([]byte, 12)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func main() {
	httpClient = &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	var err error
	tmpl, err = template.ParseFiles("templates/index.html")
	if err != nil {
		logger.Error("template parse failed", "err", err)
		os.Exit(1)
	}

	go blitzortungThread()

	r := chi.NewRouter()
	r.Use(chimw.RealIP)
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.RequestSize(1024 * 1024))
	r.Use(nonceMiddleware)
	r.Use(securityHeaders)

	r.Get("/", handleIndex)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok"))
	})
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))

	// API routes — global 2/s burst + per-endpoint limits
	r.Group(func(r chi.Router) {
		r.Use(httprate.LimitByIP(2, time.Second))
		r.With(httprate.LimitByIP(60, time.Minute)).Get("/api/search", handleSearch)
		r.With(httprate.LimitByIP(30, time.Minute)).Get("/api/weather", handleWeather)
		r.With(httprate.LimitByIP(20, time.Minute)).Get("/api/aviation", handleAviation)
		r.With(httprate.LimitByIP(20, time.Minute)).Get("/api/airspace", handleAirspace)
		r.With(httprate.LimitByIP(60, time.Minute)).Get("/api/station", handleStation)
		r.With(httprate.LimitByIP(30, time.Minute)).Get("/api/flightroute", handleFlightRoute)
		r.With(httprate.LimitByIP(100, time.Minute)).Get("/api/adsb", handleAdsb)
		r.With(httprate.LimitByIP(60, time.Minute)).Get("/api/lightning", handleLightning)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "5555"
	}
	logger.Info("listening", "port", port)
	if err := http.ListenAndServe(":"+port, r); err != nil {
		logger.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func handleIndex(w http.ResponseWriter, r *http.Request) {
	nonce := r.Context().Value(ctxNonce).(string)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "index.html", struct{ CspNonce string }{nonce}); err != nil {
		logger.Error("template execute failed", "err", err)
	}
}
