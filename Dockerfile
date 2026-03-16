# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o uavchum .

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM alpine:3.21

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /build/uavchum .
COPY static/    static/
COPY templates/ templates/

USER app

EXPOSE 5555

ENV PORT=5555

CMD ["./uavchum"]
