package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func nonceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonce := newNonce()
		ctx := context.WithValue(r.Context(), ctxNonce, nonce)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonce, _ := r.Context().Value(ctxNonce).(string)
		isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"

		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(self), microphone=(), camera=(), clipboard-write=(self)")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "credentialless")
		h.Set("X-XSS-Protection", "0")
		if isSecure {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}

		csp := fmt.Sprintf(
			"default-src 'self'; "+
				"base-uri 'none'; "+
				"object-src 'none'; "+
				"frame-ancestors 'none'; "+
				"frame-src 'none'; "+
				"form-action 'self'; "+
				"manifest-src 'self'; "+
				"worker-src 'self'; "+
				"script-src 'self' 'nonce-%s'; "+
				"script-src-attr 'none'; "+
				"style-src 'self'; "+
				"style-src-attr 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"img-src 'self' data: https://*.tile.openstreetmap.org "+
				"https://*.basemaps.cartocdn.com "+
				"https://tilecache.rainviewer.com; "+
				"connect-src 'self' https://nominatim.openstreetmap.org "+
				"https://*.basemaps.cartocdn.com https://api.rainviewer.com",
			nonce,
		)
		if isSecure {
			csp += "; upgrade-insecure-requests"
		}
		h.Set("Content-Security-Policy", csp)

		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/" {
			h.Set("Cache-Control", "no-store")
		}

		next.ServeHTTP(w, r)
	})
}
