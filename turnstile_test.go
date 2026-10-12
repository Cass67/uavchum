package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
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
