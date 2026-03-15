package main

import (
	"os"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// UI and search tuning knobs. All defaults can be overridden via env vars.
// Keeping these centralized avoids hardcoded numbers spread across the UI.

func envInt(name string) (int, bool) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return 0, false
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func envBool(name string) (bool, bool) {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if value == "" {
		return false, false
	}
	switch value {
	case "1", "true", "yes", "y", "on":
		return true, true
	case "0", "false", "no", "n", "off":
		return false, true
	default:
		return false, false
	}
}

func envString(name string) (string, bool) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", false
	}
	return value, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func uiMaxEntries(height int) int {
	if value, ok := envInt("VETALA_UI_MAX_ENTRIES"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	// Roughly 50 screens worth of entries by default.
	return height * 50
}

func uiLivePreviewMaxChars(width, height int) int {
	if value, ok := envInt("VETALA_UI_LIVE_PREVIEW_CHARS"); ok && value > 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	// Default to a couple screens of preview content.
	return width * height * 2
}

func uiToolDetailsDefault() bool {
	if value, ok := envBool("VETALA_UI_TOOL_DETAILS"); ok {
		return value
	}
	return false
}

func uiMouseMode() tea.MouseMode {
	if value, ok := envString("VETALA_UI_MOUSE_MODE"); ok {
		switch strings.ToLower(value) {
		case "none", "off", "false", "0":
			return tea.MouseModeNone
		case "cell", "cellmotion", "cell_motion":
			return tea.MouseModeCellMotion
		case "all", "allmotion", "all_motion":
			return tea.MouseModeAllMotion
		}
	}
	// Default to cell motion so mouse wheel scrolling works out of the box.
	// Set VETALA_UI_MOUSE_MODE=none to restore terminal selection/scrollback.
	return tea.MouseModeCellMotion
}

func uiAltScreen() bool {
	if value, ok := envBool("VETALA_UI_ALT_SCREEN"); ok {
		return value
	}
	// Default to terminal scrollback (no alt screen).
	return false
}

func uiKeyDebugEnabled() bool {
	if value, ok := envBool("VETALA_UI_KEY_DEBUG"); ok {
		return value
	}
	return false
}

func uiToolToggleKeys() []string {
	if value, ok := envString("VETALA_UI_TOGGLE_TOOL_KEYS"); ok {
		fields := strings.FieldsFunc(value, func(r rune) bool {
			return r == ',' || r == ' ' || r == ';' || r == '\t' || r == '\n'
		})
		var keys []string
		for _, f := range fields {
			if f != "" {
				keys = append(keys, f)
			}
		}
		if len(keys) > 0 {
			return keys
		}
	}
	return []string{"ctrl+t", "ctrl+shift+t"}
}

func uiHints() []string {
	if value, ok := envString("VETALA_UI_HINTS"); ok {
		v := strings.TrimSpace(strings.ToLower(value))
		if v == "off" || v == "none" || v == "false" || v == "0" {
			return nil
		}
		fields := strings.FieldsFunc(value, func(r rune) bool {
			return r == '|' || r == '\n'
		})
		var hints []string
		for _, f := range fields {
			if trimmed := strings.TrimSpace(f); trimmed != "" {
				hints = append(hints, trimmed)
			}
		}
		if len(hints) > 0 {
			return hints
		}
	}
	return []string{
		"Hints: Ctrl+T toggles tool details.",
		"Copy: Ctrl+Shift+C copies the last reply.",
		"PgUp/PgDn scroll · /help shows commands · /model switches models.",
		"Selection: use Shift+drag if mouse capture is on.",
	}
}

func uiCopyLastKeys() []string {
	if value, ok := envString("VETALA_UI_COPY_LAST_KEYS"); ok {
		fields := strings.FieldsFunc(value, func(r rune) bool {
			return r == ',' || r == ' ' || r == ';' || r == '\t' || r == '\n'
		})
		var keys []string
		for _, f := range fields {
			if f != "" {
				keys = append(keys, f)
			}
		}
		if len(keys) > 0 {
			return keys
		}
	}
	return []string{"ctrl+shift+c"}
}

func uiToolResultMaxLinesCompact(height int) int {
	if value, ok := envInt("VETALA_UI_TOOL_RESULT_MAX_LINES"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	return maxInt(6, height/3)
}

func uiToolResultMaxLinesExpanded(height int) int {
	if value, ok := envInt("VETALA_UI_TOOL_RESULT_MAX_LINES_EXPANDED"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	return maxInt(12, (height*2)/3)
}

func uiToolArgsMaxLinesCompact(height int) int {
	if value, ok := envInt("VETALA_UI_TOOL_ARGS_MAX_LINES"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	return maxInt(4, height/4)
}

func uiToolArgsMaxLinesExpanded(height int) int {
	if value, ok := envInt("VETALA_UI_TOOL_ARGS_MAX_LINES_EXPANDED"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	return maxInt(12, (height*2)/3)
}

func uiSelectVisibleRows(height int) int {
	if value, ok := envInt("VETALA_UI_SELECT_ROWS"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	return clampInt(height/2, 4, maxInt(6, height-6))
}

func uiContainerGutter(width int) int {
	if value, ok := envInt("VETALA_UI_CONTAINER_GUTTER"); ok && value >= 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	// Default to no gutter so content is left-aligned and fills the terminal.
	return 0
}

func uiContainerPadding(width int) int {
	if value, ok := envInt("VETALA_UI_CONTAINER_PADDING"); ok && value >= 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	// Add a subtle inset so leftmost text doesn't clip against the terminal edge.
	return clampInt(width/200, 1, 2)
}

func uiContainerPaddingY(height int) int {
	if value, ok := envInt("VETALA_UI_CONTAINER_PADDING_Y"); ok && value >= 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	// Scale lightly with terminal height; keep small by default.
	return clampInt(height/40, 1, 2)
}

func uiInputPaddingX(width int) int {
	if value, ok := envInt("VETALA_UI_INPUT_PADDING"); ok && value >= 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	// Keep a small, consistent inset inside the input bar.
	return clampInt(width/120, 1, 2)
}

func uiInputMinRows(height int) int {
	if value, ok := envInt("VETALA_UI_INPUT_MIN_ROWS"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	// Keep at least a single row; allow a second row on taller terminals.
	return clampInt(height/24, 1, 2)
}

func uiInputMaxRows(height int) int {
	if value, ok := envInt("VETALA_UI_INPUT_MAX_ROWS"); ok && value > 0 {
		return value
	}
	if height <= 0 {
		height = 24
	}
	// Limit input growth to a fraction of the terminal height.
	return clampInt(height/3, 2, maxInt(6, height/2))
}

func uiInputBackground(dark bool) string {
	if dark {
		if value, ok := envString("VETALA_UI_INPUT_BG_DARK"); ok {
			return value
		}
		// Subtle dark background.
		return "236"
	}
	if value, ok := envString("VETALA_UI_INPUT_BG_LIGHT"); ok {
		return value
	}
	// Subtle light background.
	return "255"
}

func uiDashboardColumnGap(width int) int {
	if value, ok := envInt("VETALA_UI_DASHBOARD_COLUMN_GAP"); ok && value >= 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	return clampInt(width/20, 2, 6)
}

func uiDashboardMinColumnWidth(width int) int {
	if value, ok := envInt("VETALA_UI_DASHBOARD_MIN_COL_WIDTH"); ok && value > 0 {
		return value
	}
	if width <= 0 {
		width = 80
	}
	return clampInt(width/6, 10, 24)
}

func fastSearchMaxFileBytes() int64 {
	if value, ok := envInt("VETALA_FAST_SEARCH_MAX_FILE_BYTES"); ok && value > 0 {
		return int64(value)
	}
	return 2 * 1024 * 1024
}

func fastSearchMaxLineBytes() int {
	if value, ok := envInt("VETALA_FAST_SEARCH_MAX_LINE_BYTES"); ok && value > 0 {
		return value
	}
	maxFile := fastSearchMaxFileBytes()
	defaultLimit := 1 * 1024 * 1024
	if maxFile > 0 && maxFile < int64(defaultLimit) {
		return int(maxFile)
	}
	return defaultLimit
}

func fastSearchSniffBytes() int {
	if value, ok := envInt("VETALA_FAST_SEARCH_SNIFF_BYTES"); ok && value > 0 {
		return value
	}
	return 8 * 1024
}

func fastSearchMaxMatchesPerFile() int {
	if value, ok := envInt("VETALA_FAST_SEARCH_MAX_MATCHES_PER_FILE"); ok && value > 0 {
		return value
	}
	return 100
}
