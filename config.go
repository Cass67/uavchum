package main

import (
	"bufio"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

type tokenPair struct {
	key   string
	value string
}

// readDotEnv parses one .env file into key/value pairs without touching the
// environment, so callers can pick specific values instead of exporting secrets
// into the process env.
func readDotEnv(r io.Reader) []tokenPair {
	var out []tokenPair
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		value = strings.Trim(value, "'\"")
		if key != "" {
			out = append(out, tokenPair{key: key, value: value})
		}
	}
	if err := scanner.Err(); err != nil {
		slog.Warn("failed to read .env", "err", err)
	}
	return out
}

// dotEnvPaths returns the .env locations in precedence order.
func dotEnvPaths() []string {
	paths := []string{".env"}
	if execPath, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(execPath), ".env"))
	}
	return paths
}

func loadDotEnv() {
	for _, p := range dotEnvPaths() {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		for _, entry := range readDotEnv(f) {
			if os.Getenv(entry.key) == "" {
				os.Setenv(entry.key, entry.value)
			}
		}
		f.Close()
		return
	}
}

// CARTO basemap keys are public, origin-restricted tile keys: they are embedded
// in the browser's tile URL, so the server reads them and passes them to the
// template instead of exporting them to the process env.
var cartoBasemapsKeys = []string{"CARTO_BASERMAPS_KEY", "CARTO_API_KEY"}

// loadCartoBasemapsKey resolves the basemap key from the process env first, then
// the first .env file that carries it. Values are never logged.
func loadCartoBasemapsKey(paths []string) string {
	for _, name := range cartoBasemapsKeys {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		entries := readDotEnv(f)
		f.Close()
		for _, name := range cartoBasemapsKeys {
			for _, e := range entries {
				if e.key == name && e.value != "" {
					return e.value
				}
			}
		}
	}
	return ""
}
