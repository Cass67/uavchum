package main

import (
	"os"
	"testing"
)

func TestLoadCartoBasemapsKey(t *testing.T) {
	prev := cartoBasemapsKeys
	cartoBasemapsKeys = []string{"TEST_CARTO_KEY"}
	t.Cleanup(func() { cartoBasemapsKeys = prev })

	dir := t.TempDir()
	path := dir + "/.env"
	const key = "abc123"
	if err := os.WriteFile(path, []byte("# comment\nTEST_CARTO_KEY='"+key+"'\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := loadCartoBasemapsKey([]string{path}); got != key {
		t.Fatalf("from file: got %q want %q", got, key)
	}

	if got := loadCartoBasemapsKey([]string{dir + "/missing.env"}); got != "" {
		t.Fatalf("missing file: got %q", got)
	}

	t.Setenv("TEST_CARTO_KEY", "from-env")
	if got := loadCartoBasemapsKey([]string{path}); got != "from-env" {
		t.Fatalf("process env should win: got %q", got)
	}
}
