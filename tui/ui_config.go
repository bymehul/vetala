package main

import (
	"os"
	"strconv"
	"strings"
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
