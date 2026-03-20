package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
	t.Setenv("VETALA_UI_COPY_TURN_KEYS", "ctrl+k,alt+k")
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
	if got := uiCopyTurnKeys(); len(got) != 2 || got[0] != "ctrl+k" || got[1] != "alt+k" {
		t.Fatalf("expected uiCopyTurnKeys to honor env override, got %v", got)
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

	if got := searchInFile(context.Background(), binPath, "needle", "needle", nil, 1024, 16, 10); len(got) != 0 {
		t.Fatalf("expected binary file to be skipped, got %d matches", len(got))
	}
	if got := searchInFile(context.Background(), textPath, "needle", "needle", nil, 1024, 16, 10); len(got) == 0 {
		t.Fatal("expected text file to return matches")
	}
}

func TestPerformFastSearchHiddenOptIn(t *testing.T) {
	dir := t.TempDir()
	hiddenDir := filepath.Join(dir, ".github", "workflows")
	if err := os.MkdirAll(hiddenDir, 0o755); err != nil {
		t.Fatalf("creating hidden dir: %v", err)
	}
	hiddenFile := filepath.Join(hiddenDir, "ci.yml")
	if err := os.WriteFile(hiddenFile, []byte("needle: yes\n"), 0o644); err != nil {
		t.Fatalf("writing hidden file: %v", err)
	}

	withoutHidden := performFastSearch(context.Background(), MsgFastSearch{
		Query: "needle",
		Root:  dir,
		Limit: 10,
	})
	if len(withoutHidden) != 0 {
		t.Fatalf("expected hidden files to be skipped by default, got %d matches", len(withoutHidden))
	}

	withHidden := performFastSearch(context.Background(), MsgFastSearch{
		Query:         "needle",
		Root:          dir,
		Limit:         10,
		IncludeHidden: true,
	})
	if len(withHidden) != 1 {
		t.Fatalf("expected hidden file match when includeHidden is enabled, got %d matches", len(withHidden))
	}
	if withHidden[0].FilePath != hiddenFile {
		t.Fatalf("expected hidden match path %q, got %q", hiddenFile, withHidden[0].FilePath)
	}
}

func TestPerformFastSearchHonorsGlobs(t *testing.T) {
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	docsDir := filepath.Join(dir, "docs")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("creating src dir: %v", err)
	}
	if err := os.MkdirAll(docsDir, 0o755); err != nil {
		t.Fatalf("creating docs dir: %v", err)
	}

	tsFile := filepath.Join(srcDir, "app.ts")
	txtFile := filepath.Join(docsDir, "app.txt")
	if err := os.WriteFile(tsFile, []byte("needle\n"), 0o644); err != nil {
		t.Fatalf("writing ts file: %v", err)
	}
	if err := os.WriteFile(txtFile, []byte("needle\n"), 0o644); err != nil {
		t.Fatalf("writing txt file: %v", err)
	}

	matches := performFastSearch(context.Background(), MsgFastSearch{
		Query: "needle",
		Root:  dir,
		Globs: []string{"src/**/*.ts"},
		Limit: 10,
	})
	if len(matches) != 1 {
		t.Fatalf("expected exactly one glob-filtered match, got %d", len(matches))
	}
	if matches[0].FilePath != tsFile {
		t.Fatalf("expected glob-filtered match path %q, got %q", tsFile, matches[0].FilePath)
	}
}

func TestRenderFooterIncludesActiveSkills(t *testing.T) {
	m := initialModel(nil)
	m.width = 100
	m.height = 30
	m.status = "Ready"
	m.skillLabels = []string{"code-review (pinned)", "react-vite-guide (auto)"}
	m.turnReasoning = "high"
	m.turnPhase = "planning"

	footer := m.renderFooter()
	if !strings.Contains(footer, "skills: code-review (pinned), react-vite-guide (auto)") {
		t.Fatalf("expected footer to include active skills, got %q", footer)
	}
	if !strings.Contains(footer, "reasoning: high") || !strings.Contains(footer, "phase: planning") {
		t.Fatalf("expected footer to include turn reasoning and phase, got %q", footer)
	}
	if !strings.Contains(footer, "Ctrl+K copy turn") {
		t.Fatalf("expected footer to advertise copy-turn shortcut, got %q", footer)
	}
}

func TestRenderLiveStatusIncludesPlanProgress(t *testing.T) {
	m := initialModel(nil)
	m.width = 100
	m.height = 30
	m.currentPlan = PlanUpdateData{
		Title:       "Plan",
		Explanation: "Inspect first, then explain the main flow.",
		Steps: []PlanStepData{
			{Id: "inspect", Label: "Inspect src/agent.ts and nearby files", Status: "completed"},
			{Id: "decide", Label: "Decide which flows matter most", Status: "in_progress"},
			{Id: "execute", Label: "Trace the main execution path", Status: "pending"},
		},
	}

	live := m.renderLiveStatus()
	if !strings.Contains(live, "Plan") {
		t.Fatalf("expected live status to include a plan block, got %q", live)
	}
	if !strings.Contains(live, "[x]") || !strings.Contains(live, "[>]") || !strings.Contains(live, "[ ]") {
		t.Fatalf("expected live status to include checkbox markers, got %q", live)
	}
	if !strings.Contains(live, "Trace the main execution path") {
		t.Fatalf("expected live status to include plan step labels, got %q", live)
	}
}

func TestLastTurnLogTextIncludesPlanActivityAndStatus(t *testing.T) {
	m := initialModel(nil)
	m.status = "Running agent"
	m.running = true
	m.skillLabels = []string{"react-best-practices (auto)"}
	m.turnReasoning = "high"
	m.turnPhase = "inspecting"
	m.entries = []EntryData{
		{Kind: "assistant", Text: "Earlier reply"},
		{Kind: "user", Text: "refactor test-react/App.tsx"},
		{Kind: "thinking", Text: "- inspect file\n- make one change"},
		{Kind: "tool", Text: "⬢  read_file\n{\n  \"path\": \"test-react/App.tsx\"\n}"},
		{Kind: "assistant", Text: "I found one small cleanup."},
	}
	m.currentPlan = PlanUpdateData{
		Title:       "Plan",
		Explanation: "Inspect first, then edit safely.",
		Steps: []PlanStepData{
			{Id: "inspect", Label: "Inspect App.tsx", Status: "completed"},
			{Id: "execute", Label: "Apply one small change", Status: "in_progress"},
		},
	}
	activity := "Running replace_in_file."
	m.activity = &activity
	m.liveBuffer = "Drafting final summary"

	got := m.lastTurnLogText()
	if !strings.Contains(got, "user\n  refactor test-react/App.tsx") {
		t.Fatalf("expected last turn log to start from the last user turn, got %q", got)
	}
	if strings.Contains(got, "Earlier reply") {
		t.Fatalf("expected earlier turns to be excluded, got %q", got)
	}
	if !strings.Contains(got, "Plan\nInspect first, then edit safely.") {
		t.Fatalf("expected plan block in copied turn log, got %q", got)
	}
	if !strings.Contains(got, "[x] Inspect App.tsx") || !strings.Contains(got, "[>] Apply one small change") {
		t.Fatalf("expected plan steps in copied turn log, got %q", got)
	}
	if !strings.Contains(got, "doing\n  Running replace_in_file.") {
		t.Fatalf("expected live activity in copied turn log, got %q", got)
	}
	if !strings.Contains(got, "assistant\n  Drafting final summary") {
		t.Fatalf("expected live assistant buffer in copied turn log, got %q", got)
	}
	if !strings.Contains(got, "skills: react-best-practices (auto)") || !strings.Contains(got, "reasoning: high") || !strings.Contains(got, "phase: inspecting") {
		t.Fatalf("expected status footer context in copied turn log, got %q", got)
	}
}
