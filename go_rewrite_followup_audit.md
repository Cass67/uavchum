# Go Rewrite Follow-Up Audit

Date: 2026-03-16
Branch: `feature/go-rewrite`
Reviewed commit: `5c09163`
Previous audited rewrite base: `792cf8f`

## Executive Summary

The hardening pass materially improved the Go rewrite. The original major production blockers are largely addressed:

- explicit HTTP server timeouts and header limits are now configured
- outbound HTTP response-body handling is substantially cleaner
- the bare-metal systemd deployment path is now meaningfully sandboxed
- the proxy/rate-limit trust story is clearer and tied to the documented Cloudflare Tunnel deployment model

I consider the branch close to production-ready, but not fully there yet.

There is one remaining correctness issue I would fix before promotion:

- `handleWeather` does not check the upstream HTTP status code before decoding the response body

There is also still a meaningful confidence gap:

- there are no application tests, so the rewrite is still lightly validated for a production promotion

## Scope

Reviewed areas:

- changes since the previous audit
- HTTP server and middleware hardening
- outbound HTTP client fixes
- deployment hardening
- residual correctness and performance concerns

Commands run:

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- manual runtime checks using `PORT=5656 go run .`

Notes:

- `golangci-lint` was not installed
- `govulncheck` was not installed

## Findings

### F-001: Weather handler still ignores upstream HTTP status before decode

Severity: Medium

Location:

- `/Users/cass/git/uavchum/weather.go:77`
- `/Users/cass/git/uavchum/weather.go:86`

Evidence:

The handler performs the request and then immediately decodes the body:

```go
resp, err := httpClient.Do(req)
if err != nil {
    ...
}
defer resp.Body.Close()

var data openMeteoResponse
if err := json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(&data); err != nil {
    ...
}
```

There is no `resp.StatusCode != http.StatusOK` check before decoding.

Impact:

If Open-Meteo returns a non-200 response with a JSON body, the handler can treat it as a successful forecast with zero-value fields instead of surfacing an upstream failure. That is a correctness issue more than a direct security issue, but it is production-relevant because it can produce misleading weather and drone assessments.

Recommendation:

Check `resp.StatusCode` before decoding and return `502 Bad Gateway` on non-200 responses.

Promotion impact:

I would fix this before production promotion.

---

### F-002: Production confidence is still limited by missing tests

Severity: Low

Location:

- repository-wide

Evidence:

Verification results:

- `go test ./...` passed with `? uavchum [no test files]`
- `go test -race ./...` passed with `? uavchum [no test files]`

Impact:

The recent hardening changes look sound, but there is little automated evidence that the handlers, aggregation logic, and edge-case behavior are stable. For a recent language rewrite, that reduces confidence even if the code quality is improving.

Recommendation:

Add at least a small focused test set covering:

- request validation behavior
- upstream non-200 handling
- JSON shaping for key endpoints
- a few regression tests around the drone/weather transformation logic

Promotion impact:

Not a hard blocker if deployment volume is modest and rollback is easy, but still a meaningful gap.

## What Improved Since The Previous Audit

### Server hardening

The service now uses an explicit `http.Server` with:

- `ReadHeaderTimeout`
- `ReadTimeout`
- `WriteTimeout`
- `IdleTimeout`
- `MaxHeaderBytes`

Reference:

- [/Users/cass/git/uavchum/main.go](/Users/cass/git/uavchum/main.go#L121)

This resolves the earlier internet-facing hardening concern.

### Proxy/rate-limit posture

`RealIP` is now only enabled in production, with an explicit comment tying that trust to Cloudflare Tunnel as the sole ingress.

Reference:

- [/Users/cass/git/uavchum/main.go](/Users/cass/git/uavchum/main.go#L84)
- [/Users/cass/git/uavchum/README.md](/Users/cass/git/uavchum/README.md#L97)

This is better than before, though it still depends on deployment discipline.

### Outbound HTTP resource handling

The outbound client paths now close bodies more consistently and use bounded readers in more places.

References:

- [/Users/cass/git/uavchum/search.go](/Users/cass/git/uavchum/search.go#L33)
- [/Users/cass/git/uavchum/adsb.go](/Users/cass/git/uavchum/adsb.go#L40)
- [/Users/cass/git/uavchum/aviation.go](/Users/cass/git/uavchum/aviation.go#L106)
- [/Users/cass/git/uavchum/airspace.go](/Users/cass/git/uavchum/airspace.go#L49)

This substantially improves resilience under upstream failures.

### Deployment hardening

The systemd unit now adds a real sandboxing baseline:

- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- `PrivateTmp=yes`
- `PrivateDevices=yes`
- additional kernel and namespace restrictions

Reference:

- [/Users/cass/git/uavchum/deploy/uavchum.service](/Users/cass/git/uavchum/deploy/uavchum.service#L14)

This closes most of the earlier gap between the container and bare-metal deployment paths.

## Performance View

The branch is healthier operationally than before, but it is not yet strongly optimized.

What looks better:

- reduced resource-leak risk in outbound requests
- `sort.Slice` replaced the quadratic insertion sort in the lightning path

Reference:

- [/Users/cass/git/uavchum/lightning.go](/Users/cass/git/uavchum/lightning.go#L176)

What still limits user-perceived performance:

- major endpoints still perform sequential third-party fan-out
- `/api/aviation` remains latency-bound by multiple external services

Reference:

- [/Users/cass/git/uavchum/aviation.go](/Users/cass/git/uavchum/aviation.go#L48)

Manual runtime sample:

- `/api/aviation?station=EGLL` completed in about `5.15s` during spot checking

Conclusion:

This is now more production-safe than before, but not yet a strongly optimized Go service. Performance is acceptable for modest traffic, assuming upstreams remain healthy.

## Recommendation

Recommendation: fix the remaining weather status-code bug, then promote.

If the production deployment model is exactly what the repo now documents:

- app behind Cloudflare Tunnel
- no alternate direct ingress path
- modest traffic profile
- easy rollback path

then I would be comfortable promoting after that one fix.

If you want a stricter bar before promotion, do these first:

1. Fix the weather upstream status handling.
2. Add a minimal test suite for the key handlers and transformations.
3. Install and run `govulncheck`.
4. Install and run `golangci-lint`.

## Final Opinion

Current state: almost production-ready, but not quite.

My call:

- not ready this second
- likely ready after one small correctness fix
- acceptable for moderate real-world use after that
- still worth further optimization later, especially around sequential upstream fan-out

