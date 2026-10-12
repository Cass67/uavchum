package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	turnstileSessionCookieName = "uavchum_turnstile"
	turnstileSessionTTL        = 2 * time.Hour
)

var (
	turnstileSiteKey   string
	turnstileSecretKey string
)

func loadTurnstileConfig() {
	turnstileSiteKey = os.Getenv("TURNSTILE_SITE_KEY")
	turnstileSecretKey = os.Getenv("TURNSTILE_SECRET_KEY")
}

func verifyTurnstileToken(token string) bool {
	if turnstileSecretKey == "" || token == "" {
		return false
	}
	body, _ := json.Marshal(map[string]string{
		"secret":   turnstileSecretKey,
		"response": token,
	})
	req, err := http.NewRequest("POST", "https://challenges.cloudflare.com/turnstile/v0/siteverify", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var payload struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return false
	}
	return payload.Success
}

func turnstileSessionValue(expires time.Time) string {
	expiresUnix := expires.Unix()
	message := fmt.Sprintf("%d", expiresUnix)
	mac := hmac.New(sha256.New, []byte(turnstileSecretKey))
	mac.Write([]byte(message))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return message + ":" + sig
}

func validTurnstileSession(value string, now time.Time) bool {
	if turnstileSecretKey == "" || value == "" {
		return false
	}
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return false
	}
	expiresUnix, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || now.Unix() > expiresUnix {
		return false
	}
	mac := hmac.New(sha256.New, []byte(turnstileSecretKey))
	mac.Write([]byte(parts[0]))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(parts[1]), []byte(expectedSig))
}

func setTurnstileSessionCookie(w http.ResponseWriter, r *http.Request) {
	expires := time.Now().Add(turnstileSessionTTL)
	// Secure is set whenever the request actually arrived over TLS; it is
	// deliberately off for plain-HTTP local development, where a Secure cookie
	// would never be stored.
	// nosemgrep: go.lang.security.audit.net.cookie-missing-secure.cookie-missing-secure
	http.SetCookie(w, &http.Cookie{
		Name:     turnstileSessionCookieName,
		Value:    turnstileSessionValue(expires),
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(turnstileSessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	})
}

func handleTurnstileSession(w http.ResponseWriter, r *http.Request) {
	// Token already validated by requireTurnstile, which set the session cookie.
	jsonOK(w, map[string]bool{"ok": true})
}

// handleTurnstileVerify exchanges a one-time Turnstile token for the signed
// session cookie that unlocks the data endpoints. It sits outside the
// requireTurnstile group: it is the only route that accepts a raw token, so the
// token stays out of query strings and cookies of data requests.
func handleTurnstileVerify(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Turnstile-Token")
	if token == "" {
		token = r.URL.Query().Get("turnstile_token")
	}
	if token == "" || !verifyTurnstileToken(token) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "Turnstile verification failed."})
		return
	}
	setTurnstileSessionCookie(w, r)
	jsonOK(w, map[string]bool{"ok": true})
}

func requireTurnstile(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if turnstileSecretKey == "" {
			next.ServeHTTP(w, r)
			return
		}
		if cookie, err := r.Cookie(turnstileSessionCookieName); err == nil && validTurnstileSession(cookie.Value, time.Now()) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "Turnstile verification required."})
		return
	})
}
