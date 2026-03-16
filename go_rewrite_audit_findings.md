# Go Rewrite Audit Findings

Date: 2026-03-16
Branch: `feature/go-rewrite`
Baseline: `main` at `9bfa3f4ed9337cd6a82b5d0a861ed16870f932bd`
Reviewed commit: `792cf8f02a7a66810742a2945c1429f4df213766`

## Executive Summary

The Go rewrite is a reasonable functional port, and the code is generally readable, straightforward, and deployable. It is not yet a production promotion candidate as-is.

The largest gaps are not language-specific. They are production hardening and operational concerns introduced during the rewrite:

- app-level HTTP server protections were dropped
- proxy-derived client identity is trusted too loosely for rate limiting and security policy
- several outbound HTTP paths mishandle response bodies under failure
- the heaviest endpoints are still serial fan-out aggregators, so latency is bounded by multiple third-party services rather than by Go runtime efficiency

The rewrite likely improves baseline memory footprint and startup characteristics versus Python/Gunicorn, but the current implementation does not yet fully realize a clear production performance advantage.

## Scope

Reviewed areas:

- diff from `main` to `feature/go-rewrite`
- HTTP entrypoint and middleware
- request validation and template usage
- external API fan-out paths
- concurrency and shared-state usage
- deployment hardening in Docker and systemd assets
- test and analyzer coverage

Commands run:

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`

Result:

- tests passed, but there are no Go test files
- race run passed, but there are no tests to exercise behavior
- vet passed
- `govulncheck` was not installed, so no dependency vulnerability scan was performed

## Findings

### F-001: Missing app-level HTTP server timeouts and header limits

Severity: High

Location:

- `/Users/cass/git/uavchum/main.go:113`
- `/Users/cass/git/uavchum/main.go:60`

Evidence:

The service starts with:

```go
if err := http.ListenAndServe(":"+port, r); err != nil {
```

There is no configured `http.Server` with:

- `ReadHeaderTimeout`
- `ReadTimeout`
- `WriteTimeout`
- `IdleTimeout`
- `MaxHeaderBytes`

Impact:

This is a production hardening regression for an internet-facing service. Slowloris-style behavior, oversized headers, and hung client connections have less resistance than they should.

Why it matters relative to the rewrite:

The Python app sat behind Gunicorn/Flask. The Go port now owns the HTTP server directly, so these limits need to be explicit in application code.

Fix:

Replace `http.ListenAndServe` with an `http.Server` configured with explicit limits appropriate for the service profile.

Promotion impact:

Blocking for production promotion.

---

### F-002: Proxy header trust makes IP-based rate limiting bypassable unless edge behavior is tightly controlled

Severity: High

Location:

- `/Users/cass/git/uavchum/main.go:81`
- `/Users/cass/git/uavchum/main.go:97`
- `/Users/cass/git/uavchum/middleware.go:21`
- `/Users/cass/go/pkg/mod/github.com/go-chi/chi/v5@v5.2.0/middleware/realip.go:24`

Evidence:

The router uses:

```go
r.Use(chimw.RealIP)
```

Then applies:

```go
r.Use(httprate.LimitByIP(2, time.Second))
```

The `chi` middleware documentation explicitly states it should only be used when the forwarding headers are trusted and sanitized by a reverse proxy.

The code also treats:

```go
r.Header.Get("X-Forwarded-Proto") == "https"
```

as a source of truth for HSTS and `upgrade-insecure-requests`.

Impact:

If the edge does not fully strip and rewrite `True-Client-IP`, `X-Real-IP`, and `X-Forwarded-For`, a client can spoof IP identity and evade IP-based rate limits. It also lets request headers influence security policy decisions.

Context from the Python version:

The Python app used `ProxyFix` and also supported trusted hosts:

- `/Users/cass/git/uavchum/app.py:39`
- `/Users/cass/git/uavchum/app.py:48`

The Go rewrite does not implement comparable host trust controls in app code.

Fix:

- only honor forwarded headers when requests originate from trusted ingress
- otherwise rate-limit on socket peer address
- avoid using unsanitized request headers as the basis for transport security decisions

Promotion impact:

Blocking unless deployment guarantees this at the edge and that guarantee is documented and enforced.

---

### F-003: Response body handling is incorrect on several failure paths

Severity: Medium

Location:

- `/Users/cass/git/uavchum/search.go:32`
- `/Users/cass/git/uavchum/search.go:88`
- `/Users/cass/git/uavchum/search.go:115`
- `/Users/cass/git/uavchum/adsb.go:40`

Evidence:

Example pattern:

```go
resp, err := httpClient.Do(req)
if err != nil || resp.StatusCode != http.StatusOK {
    jsonError(...)
    return
}
defer resp.Body.Close()
```

If `err == nil` and `StatusCode != 200`, the body is not closed before return.

In `adsb.go`, `defer resp.Body.Close()` is used inside a fallback loop:

```go
for _, url := range urls {
    ...
    defer resp.Body.Close()
    ...
}
```

Impact:

Under upstream errors or fallback churn, this reduces connection reuse and can accumulate unnecessary open bodies until handler return. That degrades latency and resource usage under failure, exactly when resilience matters most.

Fix:

- close every non-nil response body immediately on all non-success paths
- avoid `defer` inside retry/fallback loops; close before the next iteration

Promotion impact:

Should be fixed before prod promotion.

---

### F-004: Heavy endpoints are still sequential third-party fan-out handlers

Severity: Medium

Location:

- `/Users/cass/git/uavchum/aviation.go:48`
- `/Users/cass/git/uavchum/aviation.go:63`
- `/Users/cass/git/uavchum/aviation.go:70`
- `/Users/cass/git/uavchum/aviation.go:87`
- `/Users/cass/git/uavchum/aviation.go:98`
- `/Users/cass/git/uavchum/airspace.go:300`
- `/Users/cass/git/uavchum/airspace.go:330`
- `/Users/cass/git/uavchum/airspace.go:346`
- `/Users/cass/git/uavchum/airspace.go:373`
- `/Users/cass/git/uavchum/airspace.go:422`

Evidence:

`/api/aviation` performs multiple independent upstream calls in sequence:

- METAR
- TAF
- AIRSIGMET
- PIREP
- NOTAM sources

`/api/airspace` similarly performs multiple sequential fetches:

- FAA controlled airspace
- FAA UAS facility map
- TFRs
- nearby airports
- reverse geocode fallback
- OpenAIP fetch/filter

Impact:

The latency profile is still dominated by third-party API fan-out. Go can reduce interpreter overhead and improve concurrency, but the current design leaves most performance on the table because these requests are serialized.

Fix:

- parallelize independent upstream calls with goroutines and context cancellation
- support partial-result responses instead of making one slow source delay the whole endpoint
- add light caching for the most expensive shared datasets where freshness permits

Promotion impact:

Not a security blocker, but it weakens the case for promoting the Go rewrite primarily on performance grounds.

---

### F-005: Lightning endpoint has avoidable CPU and memory amplification

Severity: Medium

Location:

- `/Users/cass/git/uavchum/lightning.go:24`
- `/Users/cass/git/uavchum/lightning.go:142`
- `/Users/cass/git/uavchum/lightning.go:177`

Evidence:

The service keeps up to `100_000` strikes in memory:

```go
strikeMaxBuffer = 100_000
```

Each request:

- copies the full strike slice
- scans the full snapshot
- insertion-sorts the matching results

Impact:

As traffic grows, this endpoint does more work per request than necessary. The current implementation is simple and probably acceptable at small scale, but it is not efficient for sustained traffic.

Fix:

- prune expired strikes on ingest rather than on every request
- use a bounded ring buffer or time-windowed structure
- replace manual insertion sort with `sort.Slice` or a bounded top-N selection strategy

Promotion impact:

Not a blocker on its own, but it is a clear performance debt item.

---

### F-006: Deployment hardening is uneven between container and bare-metal paths

Severity: Low

Location:

- `/Users/cass/git/uavchum/compose.yml:8`
- `/Users/cass/git/uavchum/compose.yml:11`
- `/Users/cass/git/uavchum/deploy/uavchum.service:5`

Evidence:

The container deployment includes meaningful hardening:

- read-only filesystem
- dropped capabilities
- `no-new-privileges`

The systemd unit is minimal and lacks common sandboxing directives such as:

- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- `PrivateTmp=yes`
- `ProtectKernelTunables=yes`
- `RestrictAddressFamilies=...`

Impact:

If bare-metal systemd deployment is a real production path, it is materially less hardened than the containerized path.

Fix:

Either:

- document container-only production support, or
- harden the systemd unit to a similar standard

Promotion impact:

Low if production is strictly containerized; medium otherwise.

## Design Pattern Assessment

## What makes sense

- The rewrite is easy to follow.
- Handlers validate the main user inputs before making upstream requests.
- Templates use `html/template`, which is the correct default for server-rendered HTML.
- The code avoids unnecessary abstraction for a relatively small service.
- Shared caches for OpenAIP and country lookup are pragmatic.

## What is lacking

- Too much logic is still handler-local. Transport, orchestration, upstream clients, caching, and response shaping are all collapsed into the same functions.
- There is no clear service layer or client layer, which makes testing, latency control, and error handling more difficult.
- External API access is not normalized behind reusable typed clients, so subtle resource-handling mistakes are duplicated.
- Observability is minimal. There is logging, but no metrics, no endpoint latency accounting, and no source-by-source success/failure visibility.

## Design conclusion

The design is acceptable for a small utility service, but it is not yet a strong production design for a latency-sensitive aggregator. It is closer to a direct port than a mature Go service architecture.

## Security Posture Comparison With Python

## Preserved or improved

- CSP and nonce-based script policy were preserved
- request size limiting exists
- input validation is still present
- rate limiting exists
- static assets remain local rather than CDN-hosted

## Regressions or weaker areas

- no explicit Go `http.Server` hardening
- looser trust boundary around forwarded headers
- no equivalent visible trusted host handling
- no visible dependency vulnerability scan execution in this review because `govulncheck` is not installed

## Performance Assessment

## Likely better than Python

- lower runtime overhead
- lower memory overhead at idle
- simpler deployment artifact
- no Gunicorn worker coordination overhead

## Not yet clearly better in user-perceived latency

- major endpoints are dominated by serial upstream requests
- expensive data reshaping is still done synchronously in-request
- the lightning endpoint does unnecessary per-request copying and sorting
- there is little caching of shared remote results beyond OpenAIP and country lookup

## Performance conclusion

The Go rewrite probably improves efficiency at the process level, but not enough evidence exists in this branch to claim a strong end-user latency win. The current implementation is operationally simpler than Python, but not yet materially optimized.

## Promotion Recommendation

Recommendation: Do not promote to production yet.

Minimum bar before promotion:

1. add explicit HTTP server timeouts and header limits
2. lock down proxy/header trust for rate limiting and security decisions
3. fix response body handling in outbound HTTP code
4. document and enforce the real production deployment model
5. install and run `govulncheck`

Strongly recommended next:

1. parallelize independent upstream calls in `/api/aviation` and `/api/airspace`
2. refactor outbound API calls into reusable typed clients
3. add tests for core handlers and data-shaping logic
4. add metrics for endpoint latency, upstream failures, and cache hit rates

## Verification Notes

- `go test ./...` passed
- `go test -race ./...` passed
- `go vet ./...` passed
- `govulncheck` could not be run because it was not installed
- runtime timing was not completed because local port `5555` was already in use during sampling

