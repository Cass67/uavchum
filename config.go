package main

import (
	"bufio"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func loadDotEnv() {
	paths := []string{".env"}
	if execPath, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(execPath), ".env"))
	}
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
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
			if key != "" && os.Getenv(key) == "" {
				os.Setenv(key, value)
			}
		}
		f.Close()
		if err := scanner.Err(); err != nil {
			slog.Warn("failed to read .env", "path", p, "err", err)
		}
		return
	}
}
