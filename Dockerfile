# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.26.6 AS builder

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o uavchum .

# ── Healthcheck stage ─────────────────────────────────────────────────────────
FROM alpine:3.20 AS busybox-static
RUN apk add --no-cache busybox-static

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Static Go binary (CGO_ENABLED=0) -> distroless/static: non-root, ~2MB, no OS
# layer to have CVEs, and ca-certificates/tzdata baked in for outbound HTTPS.
FROM gcr.io/distroless/static:nonroot

# Fully-static busybox for the compose healthcheck (distroless has no shell,
# and the default alpine busybox is musl-linked).
COPY --from=busybox-static /bin/busybox.static /bin/busybox

WORKDIR /app

COPY --from=builder /build/uavchum .
COPY static/    static/
COPY templates/ templates/

EXPOSE 5555

ENV PORT=5555

USER nonroot

CMD ["./uavchum"]
