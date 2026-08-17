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
