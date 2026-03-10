package main

import (
	"encoding/json"
	"fmt"
	"strings"

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

func (m model) View() string {
	if !m.ready {
		return lipgloss.Place(m.width, 2, lipgloss.Center, lipgloss.Center, "Connecting to backend...")
	}

	inputBox := m.renderInputBox()
	footerStr := m.renderFooter()

	var midSection string
	if m.modalState != ModalNone {
		modalH := 15 // Fixed approx height for modals in inline mode
		modalStr := lipgloss.Place(
			m.width-2, modalH,
			lipgloss.Center, lipgloss.Center,
			m.renderModal(),
		)
		midSection = borderStyle.Copy().
			Width(m.width - 2).
			Height(modalH).
			Render(modalStr)
	} else {
		midSection = m.renderLiveStatus()
	}

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

	parts := []string{midSection, inputBox}
	if slashBox != "" {
		parts = append(parts, slashBox)
	}
	parts = append(parts, footerStr)

	return lipgloss.JoinVertical(
		lipgloss.Left,
		parts...,
	)
}

func (m model) renderInputBox() string {
	inputStr := accentStyle.Render("❯ ") + m.textInput.View()
	if m.running {
		inputStr += mutedStyle.Render("  (agent running)")
	}
	return borderStyle.Copy().Width(m.width - 2).Render(inputStr)
}

func (m model) renderFooter() string {
	statusSuffix := " · " + m.status
	if m.running {
		statusSuffix += " · running"
	}

	footerLeft := "/help · /undo · Ctrl+C pause · Ctrl+D exit"
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
	leftStr := lipgloss.JoinVertical(lipgloss.Left,
		accentStyle.Render("Vetala"),
		bold.Render("Ready."),
		"",
		m.renderDetailRow("provider", m.dashboard.Provider),
		m.renderDetailRow("model", m.dashboard.Model),
		m.renderDetailRow("directory", m.dashboard.Workspace),
		m.renderDetailRow("session", m.dashboard.SessionId),
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

	return borderStyle.Copy().Width(m.width - 2).Render(content)
}

func (m model) renderDetailRow(label, value string) string {
	return lipgloss.JoinHorizontal(lipgloss.Bottom,
		mutedStyle.Copy().Width(12).Render(label),
		value,
	)
}

// renderCardsToPrint takes a slice of new entries and renders them as
// fully styled transcript cards to be printed to the terminal scrollback.
func (m model) renderCardsToPrint(entries []EntryData) string {
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
		for _, entry := range c.entries {
			style := kindMutedStyle(entry.Kind)
			label := kindLabel(entry.Kind)

			text := entry.Text

			if entry.Kind == "tool" {
				if strings.HasPrefix(text, "↳") {
					// Tool result - render compactly
					resultText := strings.TrimPrefix(text, "↳")
					resultText = strings.TrimSpace(resultText)
					truncated := truncateLines(resultText, 10)
					block := mutedStyle.Render("  ↳ ") + wrapText(truncated, m.width-10)
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
								argsBlock = "  " + mutedStyle.Render(truncateLines(argsStr, 3))
							}
						} else {
							argsBlock = "  " + mutedStyle.Render(truncateLines(argsStr, 3))
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
				block := bold.Render(label) + "\n" + wrapText(text, m.width-6)
				cardContent = append(cardContent, block)
				continue
			}

			// Default rendering for other kinds
			text = truncateLines(text, 40)
			block := style.Render(label) + "\n" + wrapText(text, m.width-6)
			cardContent = append(cardContent, block)
		}

		cardStr := lipgloss.JoinVertical(lipgloss.Left, cardContent...)
		borderedCard := lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(c.color).
			Padding(0, 1).
			Width(m.width - 2). // Match main container width
			Render(cardStr)

		b.WriteString(borderedCard + "\n\n")
	}

	return strings.TrimRight(b.String(), "\n")
}

func (m model) renderLiveStatus() string {
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

		if m.liveBuffer != "" {
			bufStr := accentStyle.Render("assistant") + "\n" + wrapText(truncateLines(m.liveBuffer, 40), m.width-6)
			liveContent = append(liveContent, bufStr)
		}

		if len(liveContent) > 0 {
			liveStr := lipgloss.JoinVertical(lipgloss.Left, liveContent...)
			borderedLive := lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(accentColor).
				Padding(0, 1).
				Width(m.width - 2). // Match main container width
				Render(liveStr)

			return borderedLive
		}
	}

	return ""
}

func (m model) renderModal() string {
	var content string

	cursor := func(idx int, text string) string {
		if m.modalSelection == idx {
			return accentStyle.Render("❯ " + text)
		}
		return "  " + text
	}

	switch m.modalState {
	case ModalTrust:
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render("Accessing workspace"),
			"",
			m.trustWs,
			"",
			"Quick safety check: is this a project you",
			"created or one you trust?",
			"",
			"Vetala will be able to read, edit, and",
			"execute files here.",
			"",
			cursor(0, "1. Yes, I trust this folder"),
			cursor(1, "2. No, exit"),
			"",
			mutedStyle.Render("Press 1, 2, or arrow keys + Enter"),
		)
	case ModalApproval:
		content = lipgloss.JoinVertical(lipgloss.Left,
			warnStyle.Render("Approval required"),
			"",
			promptWrap(m.approvalData, 60),
			"",
			cursor(0, "1. Allow once"),
			cursor(1, "2. Allow for session"),
			cursor(2, "3. Deny"),
			"",
			mutedStyle.Render("Press 1, 2, 3, or arrow keys + Enter"),
		)
	case ModalExit:
		content = lipgloss.JoinVertical(lipgloss.Left,
			errorStyle.Render("Exit Vetala?"),
			"",
			"Session state is already saved.",
			"",
			cursor(0, "1. Exit"),
			cursor(1, "2. Stay"),
			"",
			mutedStyle.Render("Press 1, 2, or arrow keys + Enter"),
		)
	case ModalPause:
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render("Paused"),
			"",
			"Press Ctrl+C again to resume.",
			"Press Ctrl+D to exit.",
		)
	case ModalSelect:
		var items []string
		items = append(items, accentStyle.Render(m.promptSelectTitle), "")
		for i, opt := range m.promptSelectOptions {
			items = append(items, cursor(i, fmt.Sprintf("%d. %s", i+1, opt)))
		}
		items = append(items, "", mutedStyle.Render("Press Up/Down and Enter"))
		content = lipgloss.JoinVertical(lipgloss.Left, items...)

	case ModalInput:
		content = lipgloss.JoinVertical(lipgloss.Left,
			accentStyle.Render(m.promptInputTitle),
			"",
			mutedStyle.Render(m.promptInputText),
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
	{"resume", "/resume ", "Resume a prior session"},
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
	var lines []string
	lines = append(lines, accentStyle.Render("Commands"))
	lines = append(lines, mutedStyle.Render("Tab autocompletes the first match."))
	for i, s := range suggestions {
		nameCol := lipgloss.NewStyle().Width(20).Render(s.completion)
		detailCol := mutedStyle.Render(s.detail)
		if i == 0 {
			nameCol = accentStyle.Render("❯ " + lipgloss.NewStyle().Width(18).Render(s.completion))
		} else {
			nameCol = "  " + nameCol
		}
		lines = append(lines, nameCol+detailCol)
	}
	return borderStyle.Copy().Width(m.width - 2).Render(
		lipgloss.JoinVertical(lipgloss.Left, lines...),
	)
}
