package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

// Styles
var (
	accentColor = lipgloss.Color("39")  // Blue
	mutedColor  = lipgloss.Color("241") // Gray
	warnColor   = lipgloss.Color("214") // Yellow/Orange
	errorColor  = lipgloss.Color("196") // Red
	bold        = lipgloss.NewStyle().Bold(true)

	borderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(mutedColor)

	accentStyle = lipgloss.NewStyle().Foreground(accentColor)
	mutedStyle  = lipgloss.NewStyle().Foreground(mutedColor)
	warnStyle   = lipgloss.NewStyle().Foreground(warnColor)
	errorStyle  = lipgloss.NewStyle().Foreground(errorColor)

	kindUserStyle      = bold.Copy()
	kindAssistantStyle = accentStyle.Copy()
	kindToolStyle      = accentStyle.Copy()
	kindInfoStyle      = accentStyle.Copy()
	kindWarnStyle      = warnStyle.Copy()
	kindErrorStyle     = errorStyle.Copy()
	kindActivityStyle  = mutedStyle.Copy()
)

func (m *model) View() string {
	if !m.ready {
		return lipgloss.Place(m.width, 2, lipgloss.Center, lipgloss.Center, "Connecting to backend...")
	}

	inputBox := m.renderInputBox()
	footerStr := m.renderFooter()

	var midSection string
	var slashBox string
	if m.modalState == ModalNone && !m.running {
		v := m.textInput.Value()
		if strings.HasPrefix(v, "/") {
			matches := matchSlashCommands(v)
			if len(matches) > 0 {
				slashBox = m.renderSlashSuggestions(matches)
			}
		}
	}

	contentWidth := m.transcriptBoxWidth()
	contentHeight := m.availableTranscriptHeight(inputBox, slashBox, footerStr)
	m.updateViewportLayout(contentWidth, contentHeight)
	m.refreshTranscript()

	frameStyle := m.transcriptFrameStyle()
	transcriptBox := frameStyle.Copy().
		Width(contentWidth).
		Height(contentHeight).
		Render(m.viewport.View())

	if m.modalState != ModalNone {
		modalStr := lipgloss.Place(
			contentWidth, contentHeight,
			lipgloss.Center, lipgloss.Center,
			m.renderModal(),
		)
		midSection = modalStr
	} else {
		midSection = transcriptBox
	}

	parts := []string{midSection, inputBox}
	if slashBox != "" {
		parts = append(parts, slashBox)
	}
	parts = append(parts, footerStr)
	viewStr := lipgloss.JoinVertical(
		lipgloss.Left,
		parts...,
	)

	if m.modalJustClosed && m.height > 0 {
		currentHeight := lipgloss.Height(viewStr)
		if currentHeight < m.height {
			blankWidth := m.width
			if blankWidth < 1 {
				blankWidth = 1
			}
			blankLine := strings.Repeat(" ", blankWidth)
			pad := m.height - currentHeight
			padLines := strings.TrimRight(strings.Repeat(blankLine+"\n", pad), "\n")
			if padLines != "" {
				viewStr += "\n" + padLines
			}
		}
	}

	return viewStr
}

func (m *model) transcriptBoxWidth() int {
	if m.width > 0 {
		return maxInt(20, m.width)
	}
	if value, ok := envInt("COLUMNS"); ok && value > 0 {
		return maxInt(20, value)
	}
	return 80
}

func (m *model) transcriptContentWidth() int {
	frameW, _ := m.transcriptFrameStyle().GetFrameSize()
	return maxInt(10, m.transcriptBoxWidth()-frameW)
}

func (m *model) availableTranscriptHeight(inputBox, slashBox, footerStr string) int {
	height := m.height
	if height <= 0 {
		height = 24
	}
	used := lipgloss.Height(inputBox) + lipgloss.Height(footerStr)
	if slashBox != "" {
		used += lipgloss.Height(slashBox)
	}
	available := height - used
	if available < 1 {
		available = 1
	}
	return available
}

func (m *model) updateViewportLayout(boxWidth, boxHeight int) {
	frameW, frameH := m.transcriptFrameStyle().GetFrameSize()
	contentWidth := maxInt(1, boxWidth-frameW)
	contentHeight := maxInt(1, boxHeight-frameH)

	if m.viewport.Width != contentWidth || m.viewport.Height != contentHeight {
		m.viewport.Width = contentWidth
		m.viewport.Height = contentHeight
		m.transcriptDirty = true
	}
}

func (m *model) refreshTranscript() {
	if !m.transcriptDirty {
		return
	}
	content := m.renderTranscriptContent()
	m.viewport.SetContent(content)
	if m.autoScroll {
		m.viewport.GotoBottom()
	}
	m.transcriptDirty = false
}

func (m *model) renderTranscriptContent() string {
	var parts []string
	if m.showDashboard {
		parts = append(parts, m.renderDashboard())
	}
	if transcript := m.renderCardsToPrint(m.entries); transcript != "" {
		parts = append(parts, transcript)
	}
	if live := m.renderLiveStatus(); live != "" {
		parts = append(parts, live)
	}
	return strings.Join(parts, "\n\n")
}

func (m *model) transcriptFrameStyle() lipgloss.Style {
	pad := uiContainerPadding(m.width)
	return borderStyle.Copy().Padding(0, pad)
}

func (m model) renderInputBox() string {
	inputStr := accentStyle.Render("❯ ") + m.textInput.View()
	if m.running {
		inputStr += mutedStyle.Render("  (agent running)")
	}
	return borderStyle.Copy().Width(m.transcriptBoxWidth()).Render(inputStr)
}

func (m model) renderFooter() string {
	statusSuffix := " · " + m.status
	if m.running {
		statusSuffix += " · running"
	}

	footerLeft := "/help · /undo · PgUp/PgDn scroll · Ctrl+T tool details · Ctrl+C pause · Ctrl+D exit"
	footerStr := mutedStyle.Render(footerLeft)

	// Pad middle to align right
	padWidth := m.width - lipgloss.Width(footerLeft) - lipgloss.Width(statusSuffix)
	if padWidth > 0 {
		footerStr += strings.Repeat(" ", padWidth)
	}
	footerStr += mutedStyle.Render(statusSuffix)
	return footerStr
}

func (m model) renderDashboard() string {
	labels := []string{"provider", "model", "auth", "directory", "session"}
	labelWidth := 0
	for _, label := range labels {
		if len(label) > labelWidth {
			labelWidth = len(label)
		}
	}
	leftStr := lipgloss.JoinVertical(lipgloss.Left,
		accentStyle.Render("Vetala"),
		bold.Render("Ready."),
		"",
		m.renderDetailRow("provider", m.dashboard.Provider, labelWidth),
		m.renderDetailRow("model", m.dashboard.Model, labelWidth),
		m.renderDetailRow("auth", func() string {
			if m.dashboard.IsLoggedIn {
				return accentStyle.Render("Logged In")
			}
			return warnStyle.Render("Logged Out")
		}(), labelWidth),
		m.renderDetailRow("directory", m.dashboard.Workspace, labelWidth),
		m.renderDetailRow("session", m.dashboard.SessionId, labelWidth),
	)

	rightStr := lipgloss.JoinVertical(lipgloss.Left,
		accentStyle.Render("Tips"),
		"/help for commands",
		"/model for provider + model",
		"/undo to revert last edit",
		"/skill to inspect local skills",
		"Ctrl+C to pause",
		"Ctrl+D to exit",
		"",
		mutedStyle.Render("status: "+m.status),
	)

	// Combine left and right with padding
	content := lipgloss.JoinHorizontal(lipgloss.Top,
		lipgloss.NewStyle().PaddingRight(4).Render(leftStr),
		rightStr,
	)

	return borderStyle.Copy().Width(m.transcriptContentWidth()).Render(content)
}

func (m model) renderDetailRow(label, value string, labelWidth int) string {
	return lipgloss.JoinHorizontal(lipgloss.Bottom,
		mutedStyle.Copy().Width(labelWidth+2).Render(label),
		value,
	)
}

// renderCardsToPrint takes a slice of entries and renders them as transcript cards.
func (m *model) renderCardsToPrint(entries []EntryData) string {
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder

	// Group historical entries into cards
	type card struct {
		entries []EntryData
		color   lipgloss.Color
	}
	var cards []card
	var currentCard *card

	for _, entry := range entries {
		if entry.Kind == "user" || currentCard == nil {
			if currentCard != nil {
				cards = append(cards, *currentCard)
			}
			currentCard = &card{color: mutedColor}
		}
		currentCard.entries = append(currentCard.entries, entry)

		if entry.Kind == "error" {
			currentCard.color = errorColor
		} else if entry.Kind == "warn" && currentCard.color != errorColor {
			currentCard.color = warnColor
		}
	}
	if currentCard != nil {
		cards = append(cards, *currentCard)
	}

	// Render historical cards
	for _, c := range cards {
		var cardContent []string
		cardWidth := m.transcriptContentWidth()
		cardStyle := lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(c.color).
			Padding(0, 1).
			Width(cardWidth)
		frameW, _ := cardStyle.GetFrameSize()
		innerWidth := maxInt(1, cardWidth-frameW)

		for _, entry := range c.entries {
			style := kindMutedStyle(entry.Kind)
			label := kindLabel(entry.Kind)

			text := entry.Text

			if entry.Kind == "tool" {
				if strings.HasPrefix(text, "↳") {
					// Tool result - render compactly
					resultText := strings.TrimPrefix(text, "↳")
					resultText = strings.TrimSpace(resultText)
					maxLines := uiToolResultMaxLinesCompact(m.height)
					if m.showToolDetails {
						maxLines = uiToolResultMaxLinesExpanded(m.height)
					}
					truncated := truncateLines(resultText, maxLines)
					block := mutedStyle.Render("  ↳ ") + wrapText(truncated, maxInt(1, innerWidth-4))
					cardContent = append(cardContent, block)
					continue
				}
				lines := strings.SplitN(text, "\n", 2)
				toolHeader := lines[0]
				if !strings.HasPrefix(toolHeader, "⬢") {
					toolHeader = "⬢  " + toolHeader
				}

				var argsBlock string
				if len(lines) > 1 {
					argsStr := strings.TrimSpace(lines[1])
					if argsStr != "" {
						// It's usually a JSON object string
						if m.showToolDetails {
							maxLines := uiToolArgsMaxLinesExpanded(m.height)
							argsBlock = "  " + mutedStyle.Render(truncateLines(argsStr, maxLines))
						} else {
							var argsMap map[string]interface{}
							if err := json.Unmarshal([]byte(argsStr), &argsMap); err == nil {
								var importantArgs []string
								for k, v := range argsMap {
									if k == "file_path" || k == "TargetFile" || k == "CommandLine" || k == "command" || k == "query" || k == "url" {
										importantArgs = append(importantArgs, fmt.Sprintf("%s: %v", k, v))
									}
								}
								if len(importantArgs) > 0 {
									argsBlock = "  " + mutedStyle.Render(strings.Join(importantArgs, " · "))
								} else {
									// Fallback: just truncate the raw string
									maxLines := uiToolArgsMaxLinesCompact(m.height)
									argsBlock = "  " + mutedStyle.Render(truncateLines(argsStr, maxLines))
								}
							} else {
								maxLines := uiToolArgsMaxLinesCompact(m.height)
								argsBlock = "  " + mutedStyle.Render(truncateLines(argsStr, maxLines))
							}
						}
					}
				}

				block := accentStyle.Render(toolHeader)
				if argsBlock != "" {
					block += "\n" + argsBlock
				}
				cardContent = append(cardContent, block)
				continue
			}

			if entry.Kind == "user" {
				// User messages rendered bold
				block := bold.Render(label) + "\n" + wrapText(text, innerWidth)
				cardContent = append(cardContent, block)
				continue
			}

			if entry.Kind == "assistant" {
				if r := m.getGlamourRenderer(innerWidth); r != nil {
					out, err := r.Render(text)
					if err == nil && out != "" {
						text = strings.TrimSpace(out)
					} else {
						text = wrapText(text, innerWidth)
					}
				} else {
					text = wrapText(text, innerWidth)
				}
				block := style.Render(label) + "\n" + text
				cardContent = append(cardContent, block)
				continue
			}

			// Default rendering for other kinds
			text = truncateLines(text, uiToolResultMaxLinesCompact(m.height))
			block := style.Render(label) + "\n" + wrapText(text, innerWidth)
			cardContent = append(cardContent, block)
		}

		cardStr := lipgloss.JoinVertical(lipgloss.Left, cardContent...)
		borderedCard := cardStyle.Render(cardStr)

		b.WriteString(borderedCard + "\n\n")
	}

	return strings.TrimRight(b.String(), "\n")
}

func (m *model) renderLiveStatus() string {
	// Render live area (LiveStatusCard) in its own accented border
	if m.running || m.liveBuffer != "" {
		var liveContent []string

		if m.activity != nil {
			actStr := mutedStyle.Render("doing") + "\n" + m.spinner.View() + " " + mutedStyle.Render(*m.activity)
			liveContent = append(liveContent, actStr)
		} else if m.running {
			actStr := mutedStyle.Render("doing") + "\n" + m.spinner.View() + " " + mutedStyle.Render("Thinking...")
			liveContent = append(liveContent, actStr)
		}

		cardWidth := m.transcriptContentWidth()
		cardStyle := lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accentColor).
			Padding(0, 1).
			Width(cardWidth)
		frameW, _ := cardStyle.GetFrameSize()
		innerWidth := maxInt(1, cardWidth-frameW)

		if m.liveBuffer != "" {
			bufStr := accentStyle.Render("assistant") + "\n" + wrapText(truncateLines(m.liveBuffer, uiToolResultMaxLinesCompact(m.height)), innerWidth)
			liveContent = append(liveContent, bufStr)
		}

		if len(liveContent) > 0 {
			liveStr := lipgloss.JoinVertical(lipgloss.Left, liveContent...)
			borderedLive := cardStyle.Render(liveStr)
			return borderedLive
		}
	}

	return ""
}

func (m *model) getGlamourRenderer(width int) markdownRenderer {
	if width <= 0 {
		width = 80
	}
	dark := lipgloss.HasDarkBackground()
	if m.glamourRenderer != nil && m.glamourWidth == width && m.glamourDarkTheme == dark {
		return m.glamourRenderer
	}

	style := "dark"
	if !dark {
		style = "light"
	}

	renderer, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(style),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		m.glamourRenderer = nil
		return nil
	}

	m.glamourRenderer = renderer
	m.glamourWidth = width
	m.glamourDarkTheme = dark
	return renderer
}

func (m *model) modalContentWidth() int {
	boxWidth := m.transcriptBoxWidth()
	modalStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		Padding(1, 2)
	frameW, _ := modalStyle.GetFrameSize()
	return maxInt(20, boxWidth-frameW)
}

func (m *model) renderModal() string {
	var content string

	selected := m.modalSelection
	if m.modalState == ModalSelect && m.modalSelectReset {
		selected = 0
	}

	cursor := func(idx int, text string) string {
		if selected == idx {
			return accentStyle.Render("❯ " + text)
		}
		return "  " + text
	}

	switch m.modalState {
	case ModalTrust:
		wrapWidth := m.modalContentWidth()
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render("Accessing workspace"),
			"",
			wrapText(m.trustWs, wrapWidth),
			"",
			wrapText("Quick safety check: is this a project you created or one you trust?", wrapWidth),
			"",
			wrapText("Vetala will be able to read, edit, and execute files here.", wrapWidth),
			"",
			cursor(0, "1. Yes, I trust this folder"),
			cursor(1, "2. No, exit"),
			"",
			mutedStyle.Render("Press 1, 2, or arrow keys + Enter"),
		)
	case ModalApproval:
		wrapWidth := m.modalContentWidth()
		content = lipgloss.JoinVertical(lipgloss.Left,
			warnStyle.Render("Approval required"),
			"",
			promptWrap(m.approvalData, wrapWidth),
			"",
			cursor(0, "1. Allow once"),
			cursor(1, "2. Allow for session"),
			cursor(2, "3. Deny"),
			"",
			mutedStyle.Render("Press 1, 2, 3, or arrow keys + Enter"),
		)
	case ModalExit:
		wrapWidth := m.modalContentWidth()
		content = lipgloss.JoinVertical(lipgloss.Left,
			errorStyle.Render("Exit Vetala?"),
			"",
			wrapText("Session state is already saved.", wrapWidth),
			"",
			cursor(0, "1. Exit"),
			cursor(1, "2. Stay"),
			"",
			mutedStyle.Render("Press 1, 2, or arrow keys + Enter"),
		)
	case ModalPause:
		wrapWidth := m.modalContentWidth()
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render("Paused"),
			"",
			wrapText("Press Ctrl+C again to resume.", wrapWidth),
			wrapText("Press Ctrl+D to exit.", wrapWidth),
		)
	case ModalSelect:
		var items []string
		items = append(items, accentStyle.Render(m.promptSelectTitle), "")
		total := len(m.promptSelectOptions)
		visible := m.visibleSelectRows()
		if visible < 1 {
			visible = 1
		}
		if visible > total {
			visible = total
		}
		start := selected - (visible / 2)
		if start < 0 {
			start = 0
		}
		if start > total {
			start = total
		}
		end := start + visible
		if end > total {
			end = total
			start = end - visible
			if start < 0 {
				start = 0
			}
		}
		if selected < start {
			start = selected
			if start < 0 {
				start = 0
			}
			end = start + visible
			if end > total {
				end = total
			}
		}
		if selected >= end {
			start = selected - visible + 1
			if start < 0 {
				start = 0
			}
			end = start + visible
			if end > total {
				end = total
			}
		}
		for i := start; i < end; i++ {
			items = append(items, cursor(i, fmt.Sprintf("%d. %s", i+1, m.promptSelectOptions[i])))
		}
		if end < total {
			items = append(items, mutedStyle.Render("… more (↓)"))
		}
		if start > 0 {
			items = append(items, mutedStyle.Render("… more (↑)"))
		}
		items = append(items, "", mutedStyle.Render("Press Up/Down and Enter"))
		content = lipgloss.JoinVertical(lipgloss.Left, items...)

	case ModalInput:
		wrapWidth := m.modalContentWidth()
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render(m.promptInputTitle),
			"",
			mutedStyle.Render(promptWrap(m.promptInputText, wrapWidth)),
			"",
			m.modalInput.View(),
			"",
			mutedStyle.Render("Press Enter to submit, Esc to cancel"),
		)
	}

	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(accentColor).
		Padding(1, 2).
		Render(content)
}

// Helpers

func kindMutedStyle(kind string) lipgloss.Style {
	switch kind {
	case "user":
		return kindUserStyle
	case "assistant":
		return kindAssistantStyle
	case "tool":
		return kindToolStyle
	case "info":
		return kindInfoStyle
	case "warn":
		return kindWarnStyle
	case "error":
		return kindErrorStyle
	case "activity":
		return kindActivityStyle
	default:
		return mutedStyle
	}
}

func kindLabel(kind string) string {
	switch kind {
	case "activity":
		return "doing"
	default:
		return kind
	}
}

func wrapText(text string, width int) string {
	if width <= 0 {
		return text
	}
	// Note: lipgloss.NewStyle().Width() automatically wraps on word boundaries nicely
	return lipgloss.NewStyle().Width(width).Render(text)
}

func promptWrap(text string, width int) string {
	return lipgloss.NewStyle().Width(width).Render(text)
}

func truncateLines(text string, maxLines int) string {
	lines := strings.Split(text, "\n")
	if len(lines) > maxLines {
		hidden := len(lines) - maxLines
		lines = lines[:maxLines]
		lines = append(lines, fmt.Sprintf("... (%d more lines truncated)", hidden))
	}
	return strings.Join(lines, "\n")
}

// Slash command suggestions
type slashSuggestion struct {
	name       string
	completion string
	detail     string
}

var slashCommands = []slashSuggestion{
	{"help", "/help", "Show known commands"},
	{"model", "/model", "Model, reasoning, and auth settings"},
	{"undo", "/undo", "Revert the last tracked file edit"},
	{"skill", "/skill", "List, pin, inspect, and read local skills"},
	{"tools", "/tools", "List available tools"},
	{"history", "/history", "Show recent message history"},
	{"resume", "/resume ", "Resume a session (latest/index/id)"},
	{"new", "/new", "Start a fresh session"},
	{"approve", "/approve", "Show active approvals"},
	{"config", "/config", "Show runtime config"},
	{"logout", "/logout", "Clear local auth state"},
	{"clear", "/clear", "Clear the visible transcript"},
	{"exit", "/exit", "Exit Vetala"},
}

func matchSlashCommands(input string) []slashSuggestion {
	prefix := strings.ToLower(strings.TrimPrefix(input, "/"))
	if prefix == "" {
		return slashCommands
	}
	var result []slashSuggestion
	for _, cmd := range slashCommands {
		if strings.HasPrefix(cmd.name, prefix) {
			result = append(result, cmd)
		}
	}
	if len(result) > 8 {
		result = result[:8]
	}
	return result
}

func (m model) renderSlashSuggestions(suggestions []slashSuggestion) string {
	boxWidth := m.transcriptBoxWidth()
	maxNameWidth := 0
	for _, s := range suggestions {
		if len(s.completion) > maxNameWidth {
			maxNameWidth = len(s.completion)
		}
	}
	nameWidth := minInt(maxNameWidth+2, maxInt(12, boxWidth/2))
	detailWidth := maxInt(10, boxWidth-nameWidth-4)

	var lines []string
	lines = append(lines, accentStyle.Render("Commands"))
	lines = append(lines, mutedStyle.Render("Tab autocompletes the first match."))
	for i, s := range suggestions {
		nameCol := lipgloss.NewStyle().Width(nameWidth).Render(s.completion)
		detailCol := mutedStyle.Render(wrapText(s.detail, detailWidth))
		if i == 0 {
			nameCol = accentStyle.Render("❯ " + lipgloss.NewStyle().Width(maxInt(1, nameWidth-2)).Render(s.completion))
		} else {
			nameCol = "  " + nameCol
		}
		lines = append(lines, nameCol+detailCol)
	}
	return borderStyle.Copy().Width(boxWidth).Render(
		lipgloss.JoinVertical(lipgloss.Left, lines...),
	)
}
