package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUiConfigEnvOverrides(t *testing.T) {
	t.Setenv("VETALA_UI_MAX_ENTRIES", "123")
	t.Setenv("VETALA_UI_LIVE_PREVIEW_CHARS", "456")
	t.Setenv("VETALA_UI_TOOL_DETAILS", "true")

	if got := uiMaxEntries(10); got != 123 {
		t.Fatalf("expected uiMaxEntries to honor env override, got %d", got)
	}
	if got := uiLivePreviewMaxChars(10, 10); got != 456 {
		t.Fatalf("expected uiLivePreviewMaxChars to honor env override, got %d", got)
	}
	if got := uiToolDetailsDefault(); !got {
		t.Fatal("expected uiToolDetailsDefault to honor env override")
	}
}

func TestFastSearchEnvOverrides(t *testing.T) {
	t.Setenv("VETALA_FAST_SEARCH_MAX_FILE_BYTES", "2048")
	t.Setenv("VETALA_FAST_SEARCH_MAX_LINE_BYTES", "1024")
	t.Setenv("VETALA_FAST_SEARCH_SNIFF_BYTES", "64")
	t.Setenv("VETALA_FAST_SEARCH_MAX_MATCHES_PER_FILE", "7")

	if got := fastSearchMaxFileBytes(); got != 2048 {
		t.Fatalf("expected fastSearchMaxFileBytes to honor env override, got %d", got)
	}
	if got := fastSearchMaxLineBytes(); got != 1024 {
		t.Fatalf("expected fastSearchMaxLineBytes to honor env override, got %d", got)
	}
	if got := fastSearchSniffBytes(); got != 64 {
		t.Fatalf("expected fastSearchSniffBytes to honor env override, got %d", got)
	}
	if got := fastSearchMaxMatchesPerFile(); got != 7 {
		t.Fatalf("expected fastSearchMaxMatchesPerFile to honor env override, got %d", got)
	}
}

func TestSearchInFileSkipsBinary(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "binary.dat")
	textPath := filepath.Join(dir, "notes.txt")

	if err := os.WriteFile(binPath, []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatalf("writing binary file: %v", err)
	}
	if err := os.WriteFile(textPath, []byte("needle in a haystack\n"), 0o644); err != nil {
		t.Fatalf("writing text file: %v", err)
	}

	if got := searchInFile(binPath, "needle", "needle", nil, 1024, 16, 10); len(got) != 0 {
		t.Fatalf("expected binary file to be skipped, got %d matches", len(got))
	}
	if got := searchInFile(textPath, "needle", "needle", nil, 1024, 16, 10); len(got) == 0 {
		t.Fatal("expected text file to return matches")
	}
}
