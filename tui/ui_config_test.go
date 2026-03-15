package main

import (
	"os"
	"path/filepath"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestUiConfigEnvOverrides(t *testing.T) {
	t.Setenv("VETALA_UI_MAX_ENTRIES", "123")
	t.Setenv("VETALA_UI_LIVE_PREVIEW_CHARS", "456")
	t.Setenv("VETALA_UI_TOOL_DETAILS", "true")
	t.Setenv("VETALA_UI_CONTAINER_GUTTER", "3")
	t.Setenv("VETALA_UI_CONTAINER_PADDING", "4")
	t.Setenv("VETALA_UI_CONTAINER_PADDING_Y", "2")
	t.Setenv("VETALA_UI_DASHBOARD_COLUMN_GAP", "5")
	t.Setenv("VETALA_UI_DASHBOARD_MIN_COL_WIDTH", "9")
	t.Setenv("VETALA_UI_SELECT_OPTION_LINES", "2")
	t.Setenv("VETALA_UI_INPUT_PADDING", "2")
	t.Setenv("VETALA_UI_INPUT_MIN_ROWS", "3")
	t.Setenv("VETALA_UI_INPUT_MAX_ROWS", "9")
	t.Setenv("VETALA_UI_INPUT_BG_DARK", "234")
	t.Setenv("VETALA_UI_INPUT_BG_LIGHT", "250")
	t.Setenv("VETALA_UI_TOGGLE_TOOL_KEYS", "alt+t,ctrl+shift+t")
	t.Setenv("VETALA_UI_COPY_LAST_KEYS", "ctrl+y,alt+c")
	t.Setenv("VETALA_UI_KEY_DEBUG", "true")
	t.Setenv("VETALA_UI_MOUSE_MODE", "cell")
	t.Setenv("VETALA_UI_ALT_SCREEN", "false")
	t.Setenv("VETALA_UI_HINTS", "Hint one|Hint two")

	if got := uiMaxEntries(10); got != 123 {
		t.Fatalf("expected uiMaxEntries to honor env override, got %d", got)
	}
	if got := uiLivePreviewMaxChars(10, 10); got != 456 {
		t.Fatalf("expected uiLivePreviewMaxChars to honor env override, got %d", got)
	}
	if got := uiToolDetailsDefault(); !got {
		t.Fatal("expected uiToolDetailsDefault to honor env override")
	}
	if got := uiContainerGutter(120); got != 3 {
		t.Fatalf("expected uiContainerGutter to honor env override, got %d", got)
	}
	if got := uiContainerPadding(120); got != 4 {
		t.Fatalf("expected uiContainerPadding to honor env override, got %d", got)
	}
	if got := uiContainerPaddingY(40); got != 2 {
		t.Fatalf("expected uiContainerPaddingY to honor env override, got %d", got)
	}
	if got := uiDashboardColumnGap(120); got != 5 {
		t.Fatalf("expected uiDashboardColumnGap to honor env override, got %d", got)
	}
	if got := uiDashboardMinColumnWidth(120); got != 9 {
		t.Fatalf("expected uiDashboardMinColumnWidth to honor env override, got %d", got)
	}
	if got := uiSelectOptionMaxLines(40); got != 2 {
		t.Fatalf("expected uiSelectOptionMaxLines to honor env override, got %d", got)
	}
	if got := uiInputPaddingX(120); got != 2 {
		t.Fatalf("expected uiInputPaddingX to honor env override, got %d", got)
	}
	if got := uiInputMinRows(40); got != 3 {
		t.Fatalf("expected uiInputMinRows to honor env override, got %d", got)
	}
	if got := uiInputMaxRows(40); got != 9 {
		t.Fatalf("expected uiInputMaxRows to honor env override, got %d", got)
	}
	if got := uiInputBackground(true); got != "234" {
		t.Fatalf("expected uiInputBackground(true) to honor env override, got %s", got)
	}
	if got := uiInputBackground(false); got != "250" {
		t.Fatalf("expected uiInputBackground(false) to honor env override, got %s", got)
	}
	if got := uiToolToggleKeys(); len(got) != 2 || got[0] != "alt+t" || got[1] != "ctrl+shift+t" {
		t.Fatalf("expected uiToolToggleKeys to honor env override, got %v", got)
	}
	if got := uiCopyLastKeys(); len(got) != 2 || got[0] != "ctrl+y" || got[1] != "alt+c" {
		t.Fatalf("expected uiCopyLastKeys to honor env override, got %v", got)
	}
	if got := uiKeyDebugEnabled(); !got {
		t.Fatal("expected uiKeyDebugEnabled to honor env override")
	}
	if got := uiMouseMode(); got != tea.MouseModeCellMotion {
		t.Fatalf("expected uiMouseMode to honor env override, got %v", got)
	}
	if got := uiAltScreen(); got {
		t.Fatal("expected uiAltScreen to honor env override")
	}
	if got := uiHints(); len(got) != 2 || got[0] != "Hint one" || got[1] != "Hint two" {
		t.Fatalf("expected uiHints to honor env override, got %v", got)
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
