package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func testTurnstileSessionValue(secret string, expires time.Time) string {
	expiresUnix := expires.Unix()
	message := fmt.Sprintf("%d", expiresUnix)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return message + ":" + sig
}

func TestRequireTurnstileAcceptsValidSessionCookieWithoutToken(t *testing.T) {
	originalSecret := turnstileSecretKey
	turnstileSecretKey = "test-secret"
	t.Cleanup(func() { turnstileSecretKey = originalSecret })

	req := httptest.NewRequest(http.MethodGet, "/api/weather", nil)
	req.AddCookie(&http.Cookie{
		Name:  "uavchum_turnstile",
		Value: testTurnstileSessionValue(turnstileSecretKey, time.Now().Add(time.Hour)),
	})

	called := false
	handler := requireTurnstile(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatalf("expected valid Turnstile session cookie to allow request, got status %d", rr.Code)
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected downstream status %d, got %d", http.StatusNoContent, rr.Code)
	}
}

// TestRequireTurnstileRejectsRawTokens locks the design decision: data
// endpoints never accept a raw Turnstile token, only the signed session cookie.
// Tokens are single-use at Cloudflare, so replaying one against every endpoint
// could not work anyway, and keeping the token out of the data path means one
// exchange point to audit.
func TestRequireTurnstileRejectsRawTokens(t *testing.T) {
	originalSecret := turnstileSecretKey
	turnstileSecretKey = "test-secret"
	t.Cleanup(func() { turnstileSecretKey = originalSecret })

	for _, tc := range []struct {
		name  string
		token string
	}{
		{"header", "some-token"},
		{"query", "some-token"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/weather", nil)
		if tc.name == "header" {
			req.Header.Set("X-Turnstile-Token", tc.token)
		} else {
			req.URL.RawQuery = "turnstile_token=" + tc.token
		}
		rr := httptest.NewRecorder()
		requireTurnstile(http.NotFoundHandler()).ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Errorf("%s token accepted without a session cookie (status %d)", tc.name, rr.Code)
		}
	}
}

// TestTurnstileHappyPath walks the path a real browser takes: the widget token
// is exchanged at /api/turnstile/verify for a cookie, and that cookie unlocks a
// gated route. It also pins that app.js still sends the header verify reads,
// since that is the line whose removal took the whole site down.
func TestTurnstileHappyPath(t *testing.T) {
	siteverify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"success":true}`)
	}))
	t.Cleanup(siteverify.Close)
	origSecret, origURL := turnstileSecretKey, turnstileVerifyURL
	turnstileSecretKey, turnstileVerifyURL = "test-secret", siteverify.URL
	t.Cleanup(func() { turnstileSecretKey, turnstileVerifyURL = origSecret, origURL })

	req := httptest.NewRequest(http.MethodPost, "/api/turnstile/verify", nil)
	req.Header.Set("X-Turnstile-Token", "widget-token")
	rr := httptest.NewRecorder()
	handleTurnstileVerify(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("verify with a valid token: status %d", rr.Code)
	}
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != turnstileSessionCookieName {
		t.Fatalf("verify did not set the session cookie: %v", cookies)
	}

	gated := requireTurnstile(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for _, withCookie := range []bool{true, false} {
		req = httptest.NewRequest(http.MethodGet, "/api/weather", nil)
		want := http.StatusForbidden
		if withCookie {
			req.AddCookie(cookies[0])
			want = http.StatusOK
		}
		rr = httptest.NewRecorder()
		gated.ServeHTTP(rr, req)
		if rr.Code != want {
			t.Errorf("gated route withCookie=%v: status %d, want %d", withCookie, rr.Code, want)
		}
	}

	js, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(js), `"X-Turnstile-Token"`) || !strings.Contains(string(js), "/api/turnstile/verify") {
		t.Fatal("static/app.js no longer sends X-Turnstile-Token to /api/turnstile/verify")
	}
}
