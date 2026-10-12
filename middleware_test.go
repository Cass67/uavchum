package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// TestSecurityHeaders locks the cross-origin posture of the app: the API is
// same-origin only (no Access-Control-* header is ever sent), CORP is
// same-origin, COOP/COEP isolate the document, HSTS is a year, and the CSP
// keeps scripts nonce-locked while allowing exactly the third parties the
// frontend uses (CARTO tiles, RainViewer, Nominatim, Cloudflare Turnstile).
func TestSecurityHeaders(t *testing.T) {
	const nonce = "TESTNONCE"
	req := httptest.NewRequest(http.MethodGet, "/api/adsb?lat=1&lon=1", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	req = req.WithContext(context.WithValue(req.Context(), ctxNonce, nonce))

	rec := httptest.NewRecorder()
	securityHeaders(http.NotFoundHandler()).ServeHTTP(rec, req)
	h := rec.Header()

	for _, name := range []string{
		"Access-Control-Allow-Origin",
		"Access-Control-Allow-Credentials",
		"Access-Control-Allow-Methods",
		"Access-Control-Allow-Headers",
	} {
		if v := h.Get(name); v != "" {
			t.Errorf("%s must not be sent (API is same-origin only), got %q", name, v)
		}
	}
	for name, want := range map[string]string{
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"X-Content-Type-Options":       "nosniff",
	} {
		if v := h.Get(name); v != want {
			t.Errorf("%s = %q, want %q", name, v, want)
		}
	}
	if v := h.Get("Strict-Transport-Security"); !strings.Contains(v, "max-age=31536000") {
		t.Errorf("Strict-Transport-Security = %q, want a one-year policy", v)
	}

	csp := h.Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy missing")
	}
	if !strings.Contains(csp, "script-src 'self' 'nonce-"+nonce+"'") {
		t.Errorf("script-src must be 'self' plus the per-request nonce; csp=%s", csp)
	}
	for _, part := range strings.Split(csp, ";") {
		part = strings.TrimSpace(part)
		if strings.Contains(part, "unsafe-inline") && !strings.HasPrefix(part, "style-src-attr") {
			t.Errorf("unsafe-inline leaked into %q", part)
		}
	}
	for _, want := range []string{
		"https://*.basemaps.cartocdn.com",
		"https://tilecache.rainviewer.com",
		"https://api.rainviewer.com",
		"https://nominatim.openstreetmap.org",
		"https://challenges.cloudflare.com",
		"frame-ancestors 'none'",
		"upgrade-insecure-requests",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q", want)
		}
	}
	if strings.Contains(csp, "wss:") {
		t.Errorf("CSP should not need a wss: source (Blitzortung is server-side); csp=%s", csp)
	}
}

// TestStaticAssetsAreNotCrossOrigin checks the static file server does not
// advertise a CORS origin, so app.js (which carries the public tile key) cannot
// be read by another site.
func TestStaticAssetsAreNotCrossOrigin(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/app.js", []byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := securityHeaders(noDirListing(http.StripPrefix("/static/", http.FileServer(http.Dir(dir)))))

	req := httptest.NewRequest(http.MethodGet, "/static/app.js", nil)
	req.Header.Set("Origin", "https://evil.example")
	req = req.WithContext(context.WithValue(req.Context(), ctxNonce, "N"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("static fetch failed: %d", rec.Code)
	}
	if v := rec.Header().Get("Access-Control-Allow-Origin"); v != "" {
		t.Errorf("static asset sent Access-Control-Allow-Origin: %q", v)
	}
	if v := rec.Header().Get("Cross-Origin-Resource-Policy"); v != "same-origin" {
		t.Errorf("static asset CORP = %q, want same-origin", v)
	}
}

// TestStaticNoDirectoryListing locks the handler that stops http.FileServer
// from enumerating the app's asset tree via /static/.
func TestStaticNoDirectoryListing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/app.js", []byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := noDirListing(http.StripPrefix("/static/", http.FileServer(http.Dir(dir))))

	for _, path := range []string{"/static/", "/static"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s returned %d, want 404 (directory listing leaked?)", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/app.js", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("named static asset returned %d, want 200", rec.Code)
	}
}
