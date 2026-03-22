package main

import (
	"encoding/json"
	"fmt"
	"image/color"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/glamour"
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
	kindThinkingStyle  = accentStyle.Copy().Italic(true)
	planTitleStyle     = accentStyle.Copy().Bold(true)
)

func (m *model) View() tea.View {
	if !m.ready {
		v := tea.NewView(lipgloss.Place(m.width, 2, lipgloss.Center, lipgloss.Center, "Connecting to backend..."))
		v.MouseMode = m.mouseMode
		return v
	}

	inputBox := m.renderInputBox()
	hintsStr := m.renderHints()
	footerStr := m.renderFooter()

	var midSection string
	var slashBox string
	if m.modalState == ModalNone && !m.running {
		v := m.textArea.Value()
		if strings.HasPrefix(v, "/") {
			matches := matchSlashCommands(v)
			if len(matches) > 0 {
				slashBox = m.renderSlashSuggestions(matches)
			}
		}
	}

	contentWidth := m.transcriptBoxWidth()
	liveSection := ""
	if m.modalState == ModalNone {
		liveSection = m.renderLiveSection(contentWidth)
	}
	contentHeight := m.availableTranscriptHeight(inputBox, slashBox, footerStr, liveSection, hintsStr)
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

	parts := []string{}
	parts = append(parts, midSection)
	if liveSection != "" {
		parts = append(parts, liveSection)
	}
	parts = append(parts, inputBox)
	if slashBox != "" {
		parts = append(parts, slashBox)
	}
	if hintsStr != "" {
		parts = append(parts, hintsStr)
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

	v := tea.NewView(viewStr)
	v.MouseMode = m.mouseMode
	v.AltScreen = m.altScreen
	return v
}

func (m *model) transcriptBoxWidth() int {
	width := m.width
	if width <= 0 {
		if value, ok := envInt("COLUMNS"); ok && value > 0 {
			width = value
		} else {
			width = 80
		}
	}
	gutter := uiContainerGutter(width)
	return maxInt(20, width-gutter)
}

func (m *model) transcriptContentWidth() int {
	frameW, _ := m.transcriptFrameStyle().GetFrameSize()
	return maxInt(10, m.transcriptBoxWidth()-frameW)
}

func (m *model) availableTranscriptHeight(inputBox, slashBox, footerStr, liveSection, hintsStr string) int {
	height := m.height
	if height <= 0 {
		height = 24
	}
	used := lipgloss.Height(inputBox) + lipgloss.Height(footerStr)
	if hintsStr != "" {
		used += lipgloss.Height(hintsStr)
	}
	if liveSection != "" {
		used += lipgloss.Height(liveSection)
	}
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

	if m.viewport.Width() != contentWidth || m.viewport.Height() != contentHeight {
		m.viewport.SetWidth(contentWidth)
		m.viewport.SetHeight(contentHeight)
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
	innerWidth := m.transcriptContentWidth()
	separator := mutedStyle.Render(horizontalRule(innerWidth))
	var b strings.Builder

	appendSection := func(section string) {
		if section == "" {
			return
		}
		if b.Len() > 0 {
			b.WriteString("\n")
			if separator != "" {
				b.WriteString(separator)
				b.WriteString("\n\n")
			} else {
				b.WriteString("\n")
			}
		}
		b.WriteString(section)
	}

	if m.showDashboard {
		if m.dashboardDirty || m.dashboardWidth != innerWidth {
			m.renderedDashboard = m.renderDashboard(innerWidth)
			m.dashboardWidth = innerWidth
			m.dashboardDirty = false
		}
		appendSection(m.renderedDashboard)
	} else if m.renderedDashboard != "" {
		m.renderedDashboard = ""
	}

	if m.entriesDirty || m.entriesWidth != innerWidth || m.entriesHeight != m.height || m.entriesToolDetails != m.showToolDetails {
		m.renderedEntries = m.renderCardsToPrint(m.entries)
		m.entriesWidth = innerWidth
		m.entriesHeight = m.height
		m.entriesToolDetails = m.showToolDetails
		m.entriesDirty = false
	}
	appendSection(m.renderedEntries)

	return strings.TrimRight(b.String(), "\n")
}

func (m *model) transcriptFrameStyle() lipgloss.Style {
	padX := uiContainerPadding(m.width)
	return lipgloss.NewStyle().Padding(0, padX)
}

func (m *model) renderInputBox() string {
	padX := uiContainerPadding(m.width)
	boxWidth := m.transcriptBoxWidth()
	innerWidth := maxInt(1, boxWidth-2*padX)
	rule := mutedStyle.Render(horizontalRule(innerWidth))

	dark := m.hasDarkBackground
	if !m.bgKnown {
		dark = true
	}
	bgColor := lipgloss.Color(uiInputBackground(dark))
	bgStyle := lipgloss.NewStyle().Background(bgColor)

	inputPad := uiInputPaddingX(m.width)
	leftPad := bgStyle.Render(strings.Repeat(" ", inputPad))
	rightPad := bgStyle.Render(strings.Repeat(" ", inputPad))

	promptRaw := "❯ "
	promptWidth := lipgloss.Width(promptRaw)
	textWidth := maxInt(1, innerWidth-(inputPad*2)-promptWidth)

	minRows := uiInputMinRows(m.height)
	maxRows := uiInputMaxRows(m.height)
	if maxRows < minRows {
		maxRows = minRows
	}

	m.textArea.Prompt = ""
	m.textArea.ShowLineNumbers = false
	m.textArea.SetStyles(inputTextAreaStyles(dark, bgColor))
	m.textArea.SetWidth(textWidth)
	m.textArea.MaxHeight = maxRows

	desiredRows := clampInt(countWrappedLines(m.textArea.Value(), textWidth), minRows, maxRows)
	m.textArea.SetHeight(desiredRows)

	ti := m.textArea
	prompt := bgStyle.Copy().Foreground(accentColor).Bold(true).Render(promptRaw)
	promptPad := bgStyle.Render(strings.Repeat(" ", promptWidth))

	lines := strings.Split(ti.View(), "\n")
	if len(lines) == 0 {
		lines = []string{""}
	}

	inputLines := make([]string, 0, len(lines))
	for i, line := range lines {
		if m.running && i == len(lines)-1 {
			status := bgStyle.Copy().Foreground(mutedColor).Render("  (agent running)")
			if lipgloss.Width(line)+lipgloss.Width(status) <= textWidth {
				line += status
			}
		}
		if lineWidth := lipgloss.Width(line); lineWidth < textWidth {
			line += bgStyle.Render(strings.Repeat(" ", textWidth-lineWidth))
		}
		if i == 0 {
			inputLines = append(inputLines, leftPad+prompt+line+rightPad)
		} else {
			inputLines = append(inputLines, leftPad+promptPad+line+rightPad)
		}
	}

	content := strings.Join(append([]string{rule}, inputLines...), "\n")
	return lipgloss.NewStyle().Padding(0, padX).Width(boxWidth).Render(content)
}

func inputTextAreaStyles(dark bool, bg color.Color) textarea.Styles {
	styles := textarea.DefaultStyles(dark)
	base := lipgloss.NewStyle().Background(bg)
	muted := base.Copy().Foreground(mutedColor)
	accent := base.Copy().Foreground(accentColor)

	styles.Focused.Base = base.Copy()
	styles.Focused.Text = base.Copy()
	styles.Focused.Placeholder = muted
	styles.Focused.Prompt = accent
	styles.Focused.LineNumber = muted
	styles.Focused.CursorLine = base.Copy()
	styles.Focused.CursorLineNumber = muted
	styles.Focused.EndOfBuffer = base.Copy()

	styles.Blurred.Base = base.Copy()
	styles.Blurred.Text = base.Copy().Foreground(mutedColor)
	styles.Blurred.Placeholder = muted
	styles.Blurred.Prompt = muted
	styles.Blurred.LineNumber = muted
	styles.Blurred.CursorLine = base.Copy()
	styles.Blurred.CursorLineNumber = muted
	styles.Blurred.EndOfBuffer = base.Copy()

	styles.Cursor.Color = accentColor
	return styles
}

func (m model) statusLine() string {
	statusLine := "status: " + m.status
	if m.running {
		statusLine += " · running"
	}
	if m.showToolDetails {
		statusLine += " · tool details: on"
	} else {
		statusLine += " · tool details: off"
	}
	if m.turnReasoning != "" {
		statusLine += " · reasoning: " + m.turnReasoning
	}
	if m.turnPhase != "" {
		statusLine += " · phase: " + m.turnPhase
	}
	return statusLine
}

func (m model) renderFooter() string {
	footerLeft := fmt.Sprintf(
		"/help · /undo · PgUp/PgDn scroll · %s tool details · %s copy turn · Ctrl+C pause · Ctrl+D exit",
		formatKeyForHint(firstKey(m.toggleToolKeys, "ctrl+t")),
		formatKeyForHint(firstKey(m.copyTurnKeys, "ctrl+k")),
	)
	lines := []string{footerLeft}
	innerWidth := maxInt(1, m.transcriptBoxWidth()-2*uiContainerPadding(m.width))
	if len(m.skillLabels) > 0 {
		lines = append(lines, wrapText("skills: "+strings.Join(m.skillLabels, ", "), innerWidth))
	}
	lines = append(lines, m.statusLine())

	rendered := make([]string, 0, len(lines))
	for _, line := range lines {
		rendered = append(rendered, mutedStyle.Render(line))
	}
	footerStr := lipgloss.JoinVertical(lipgloss.Left, rendered...)
	if m.keyDebug && m.lastKeyDebug != "" {
		footerStr = lipgloss.JoinVertical(lipgloss.Left,
			footerStr,
			mutedStyle.Render(m.lastKeyDebug),
		)
	}

	padX := uiContainerPadding(m.width)
	return lipgloss.NewStyle().Padding(0, padX).Width(m.transcriptBoxWidth()).Render(footerStr)
}

func (m model) renderHints() string {
	hints := uiHints()
	if len(hints) == 0 {
		return ""
	}
	padX := uiContainerPadding(m.width)
	innerWidth := maxInt(1, m.transcriptBoxWidth()-2*padX)
	lines := make([]string, 0, len(hints))
	for _, hint := range hints {
		lines = append(lines, mutedStyle.Copy().Width(innerWidth).Render(hint))
	}
	content := strings.Join(lines, "\n")
	return lipgloss.NewStyle().Padding(0, padX).Width(m.transcriptBoxWidth()).Render(content)
}

func (m model) renderDashboard(width int) string {
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

	innerWidth := maxInt(10, width)

	gap := uiDashboardColumnGap(innerWidth)
	minCol := uiDashboardMinColumnWidth(innerWidth)
	maxLeftWidth := innerWidth - gap - minCol
	if maxLeftWidth < minCol {
		stacked := lipgloss.JoinVertical(lipgloss.Left, leftStr, "", rightStr)
		return stacked
	}
	leftLines := strings.Split(leftStr, "\n")
	maxLeft := 0
	for _, line := range leftLines {
		if w := lipgloss.Width(line); w > maxLeft {
			maxLeft = w
		}
	}
	minLeft := maxInt(minCol, innerWidth/3)
	if minLeft > maxLeftWidth {
		minLeft = maxLeftWidth
	}
	leftWidth := clampInt(maxLeft, minLeft, maxLeftWidth)
	rightWidth := maxInt(minCol, innerWidth-leftWidth-gap)

	leftBlock := lipgloss.NewStyle().Width(leftWidth).Render(leftStr)
	gapBlock := ""
	if gap > 0 {
		gapBlock = strings.Repeat(" ", gap)
	}
	rightBlock := lipgloss.NewStyle().Width(rightWidth).Render(rightStr)

	content := lipgloss.JoinHorizontal(lipgloss.Top, leftBlock, gapBlock, rightBlock)
	return content
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

	lastAssistantIdx := -1
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Kind == "assistant" {
			lastAssistantIdx = i
			break
		}
	}

	// Group historical entries into cards
	type cardEntry struct {
		idx   int
		entry EntryData
	}
	type card struct {
		entries []cardEntry
		color   color.Color
	}
	var cards []card
	var currentCard *card

	for idx, entry := range entries {
		if entry.Kind == "user" || currentCard == nil {
			if currentCard != nil {
				cards = append(cards, *currentCard)
			}
			currentCard = &card{color: mutedColor}
		}
		currentCard.entries = append(currentCard.entries, cardEntry{idx: idx, entry: entry})

		if entry.Kind == "error" {
			currentCard.color = errorColor
		} else if entry.Kind == "warn" && currentCard.color != errorColor {
			currentCard.color = warnColor
		}
	}
	if currentCard != nil {
		cards = append(cards, *currentCard)
	}

	innerWidth := m.transcriptContentWidth()
	separator := mutedStyle.Render(horizontalRule(innerWidth))

	// Render historical cards
	for idx, c := range cards {
		if idx > 0 {
			b.WriteString(separator + "\n")
		}
		var cardContent []string

		for _, item := range c.entries {
			entry := item.entry
			style := kindMutedStyle(entry.Kind)
			label := kindLabel(entry.Kind)

			text := entry.Text
			isLastAssistant := entry.Kind == "assistant" && item.idx == lastAssistantIdx

			if resultSummary, resultDetail, ok := parseToolResultText(text); ok && entry.Kind != "user" && entry.Kind != "assistant" {
				block := style.Render("↳ " + resultSummary)
				if resultDetail != "" {
					maxLines := uiToolResultMaxLinesCompact(m.height)
					if m.showToolDetails {
						maxLines = uiToolResultMaxLinesExpanded(m.height)
					}
					detail := wrapText(truncateLines(resultDetail, maxLines), maxInt(1, innerWidth-4))
					block += "\n" + mutedStyle.Render(indentLines(detail, "  "))
				}
				cardContent = append(cardContent, indentLines(block, "  "))
				continue
			}

			if entry.Kind == "tool" {
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
							argsBlock = mutedStyle.Render(truncateLines(argsStr, maxLines))
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
									argsBlock = mutedStyle.Render(strings.Join(importantArgs, " · "))
								} else {
									// Fallback: just truncate the raw string
									maxLines := uiToolArgsMaxLinesCompact(m.height)
									argsBlock = mutedStyle.Render(truncateLines(argsStr, maxLines))
								}
							} else {
								maxLines := uiToolArgsMaxLinesCompact(m.height)
								argsBlock = mutedStyle.Render(truncateLines(argsStr, maxLines))
							}
						}
					}
				}

				block := accentStyle.Render(wrapText(toolHeader, innerWidth))
				if argsBlock != "" {
					block += "\n" + indentLines(argsBlock, "  ")
				}
				cardContent = append(cardContent, indentLines(block, "  "))
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
				if isLastAssistant {
					copyKey := formatKeyForHint(firstKey(m.copyLastKeys, "ctrl+y"))
					block += "\n" + mutedStyle.Render(fmt.Sprintf("⧉ %s copy last reply", copyKey))
				}
				cardContent = append(cardContent, block)
				continue
			}

			// Default rendering for other kinds
			text = truncateLines(text, uiToolResultMaxLinesCompact(m.height))
			block := style.Render(label) + "\n" + wrapText(text, innerWidth)
			cardContent = append(cardContent, block)
		}

		cardStr := lipgloss.JoinVertical(lipgloss.Left, cardContent...)
		b.WriteString(cardStr)
		if idx < len(cards)-1 {
			b.WriteString("\n")
		}
	}

	return strings.TrimRight(b.String(), "\n")
}

func (m *model) renderLiveStatus() string {
	if m.running || m.liveBuffer != "" || len(m.currentPlan.Steps) > 0 {
		var liveContent []string
		innerWidth := m.transcriptContentWidth()

		if plan := m.renderCurrentPlan(innerWidth); plan != "" {
			liveContent = append(liveContent, plan)
		}

		if m.activity != nil {
			actStr := mutedStyle.Render("doing") + "\n" + m.spinner.View() + " " + mutedStyle.Render(*m.activity)
			liveContent = append(liveContent, actStr)
		} else if m.running {
			actStr := mutedStyle.Render("doing") + "\n" + m.spinner.View() + " " + mutedStyle.Render("Thinking...")
			liveContent = append(liveContent, actStr)
		}

		if m.liveBuffer != "" {
			bufStr := accentStyle.Render("assistant") + "\n" + wrapText(truncateLines(m.liveBuffer, uiToolResultMaxLinesCompact(m.height)), innerWidth)
			liveContent = append(liveContent, bufStr)
		}

		if len(liveContent) > 0 {
			return lipgloss.JoinVertical(lipgloss.Left, liveContent...)
		}
	}

	return ""
}

func (m *model) renderCurrentPlan(width int) string {
	if len(m.currentPlan.Steps) == 0 {
		return ""
	}

	title := m.currentPlan.Title
	if strings.TrimSpace(title) == "" {
		title = "plan"
	}
	lines := []string{planTitleStyle.Render(title)}
	if m.currentPlan.Explanation != "" {
		lines = append(lines, mutedStyle.Render(wrapText(m.currentPlan.Explanation, width)))
	}

	for _, step := range m.currentPlan.Steps {
		first, rest := planMarker(step.Status)
		label := wrapText(step.Label, maxInt(1, width-lipgloss.Width(first)))
		lines = append(lines, prefixLines(label, first, rest))
	}

	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func (m *model) renderLiveSection(boxWidth int) string {
	live := m.renderLiveStatus()
	if live == "" {
		return ""
	}
	padX := uiContainerPadding(m.width)
	innerWidth := maxInt(1, boxWidth-2*padX)
	rule := mutedStyle.Render(horizontalRule(innerWidth))
	liveBlock := padBlock(live, padX, boxWidth)
	ruleBlock := padBlock(rule, padX, boxWidth)
	return lipgloss.JoinVertical(lipgloss.Left, ruleBlock, liveBlock)
}

func (m *model) getGlamourRenderer(width int) markdownRenderer {
	if width <= 0 {
		width = 80
	}
	dark := m.hasDarkBackground
	if !m.bgKnown {
		dark = true
	}
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
	modalStyle := borderStyle.Copy().Padding(1, 2)
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
		prefix := "  "
		if selected == idx {
			prefix = accentStyle.Render("❯ ")
		}
		return prefixLines(text, prefix, strings.Repeat(" ", lipgloss.Width(prefix)))
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
			accentStyle.Render("Stopping Current Turn"),
			"",
			wrapText("Vetala is interrupting the active model or tool call.", wrapWidth),
			"",
			wrapText("The refinement prompt will appear once the backend yields control.", wrapWidth),
		)
	case ModalSelect:
		var items []string
		wrapWidth := m.modalContentWidth()
		items = append(items, accentStyle.Render(m.promptSelectTitle), "")
		total := len(m.promptSelectOptions)
		maxLines := uiSelectOptionMaxLines(m.height)
		if maxLines < 1 {
			maxLines = 1
		}
		linesBudget := m.visibleSelectRows()
		visible := maxInt(1, linesBudget/maxLines)
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
			option := fmt.Sprintf("%d. %s", i+1, m.promptSelectOptions[i])
			optionText := wrapText(option, maxInt(1, wrapWidth-2))
			optionText = truncateLinesCompact(optionText, maxLines)
			items = append(items, cursor(i, optionText))
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

	return borderStyle.Copy().
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
	case "thinking":
		return kindThinkingStyle
	default:
		return mutedStyle
	}
}

func kindLabel(kind string) string {
	switch kind {
	case "activity":
		return "doing"
	case "thinking":
		return "thinking"
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

func countWrappedLines(text string, width int) int {
	if width <= 0 {
		return 1
	}
	if text == "" {
		return 1
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	total := 0
	for _, line := range lines {
		if line == "" {
			total++
			continue
		}
		wrapped := wrapText(line, width)
		if wrapped == "" {
			total++
			continue
		}
		total += len(strings.Split(wrapped, "\n"))
	}
	if total < 1 {
		return 1
	}
	return total
}

func promptWrap(text string, width int) string {
	return lipgloss.NewStyle().Width(width).Render(text)
}

func parseToolResultText(text string) (string, string, bool) {
	if !strings.HasPrefix(text, "↳") {
		return "", "", false
	}
	trimmed := strings.TrimSpace(strings.TrimPrefix(text, "↳"))
	lines := strings.SplitN(trimmed, "\n", 2)
	summary := strings.TrimSpace(lines[0])
	detail := ""
	if len(lines) > 1 {
		detail = strings.TrimSpace(lines[1])
	}
	return summary, detail, true
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

func truncateLinesCompact(text string, maxLines int) string {
	if maxLines <= 0 {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) <= maxLines {
		return text
	}
	lines = lines[:maxLines]
	last := strings.TrimRight(lines[maxLines-1], " ")
	if last == "" {
		lines[maxLines-1] = "…"
	} else {
		lines[maxLines-1] = last + "…"
	}
	return strings.Join(lines, "\n")
}

func blankLines(width, count int) string {
	if count <= 0 {
		return ""
	}
	if width < 1 {
		width = 1
	}
	line := strings.Repeat(" ", width)
	return strings.TrimRight(strings.Repeat(line+"\n", count), "\n")
}

func padBlock(content string, padX, width int) string {
	return lipgloss.NewStyle().Padding(0, padX).Width(width).Render(content)
}

func horizontalRule(width int) string {
	if width < 1 {
		return ""
	}
	return strings.Repeat("─", width)
}

func indentLines(text, prefix string) string {
	if text == "" || prefix == "" {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = prefix + line
	}
	return strings.Join(lines, "\n")
}

func prefixLines(text, first, rest string) string {
	if text == "" {
		return first
	}
	lines := strings.Split(text, "\n")
	lines[0] = first + lines[0]
	for i := 1; i < len(lines); i++ {
		lines[i] = rest + lines[i]
	}
	return strings.Join(lines, "\n")
}

func planMarker(status string) (string, string) {
	switch status {
	case "completed":
		return accentStyle.Render("[x] "), accentStyle.Render("    ")
	case "in_progress":
		return accentStyle.Render("[>] "), accentStyle.Render("    ")
	default:
		return mutedStyle.Render("[ ] "), mutedStyle.Render("    ")
	}
}

// Slash command suggestions
type slashSuggestion struct {
	name       string
	completion string
	detail     string
}

var slashCommands = []slashSuggestion{
	{"help", "/help", "Show known commands"},
	{"diff", "/diff", "Show current git diff, including untracked files"},
	{"review", "/review", "Review current changes or compare against a base branch"},
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
	padX := uiContainerPadding(m.width)
	innerWidth := maxInt(10, boxWidth-(padX*2))
	maxNameWidth := 0
	for _, s := range suggestions {
		if len(s.completion) > maxNameWidth {
			maxNameWidth = len(s.completion)
		}
	}
	nameWidth := minInt(maxNameWidth+2, maxInt(12, innerWidth/2))
	detailWidth := maxInt(10, innerWidth-nameWidth-2)

	var lines []string
	lines = append(lines, accentStyle.Render("Commands"))
	lines = append(lines, mutedStyle.Render("↑/↓ navigate · Tab autocompletes selected."))
	selected := m.slashSelection
	if selected >= len(suggestions) {
		selected = 0
	}
	for i, s := range suggestions {
		nameCol := lipgloss.NewStyle().Width(nameWidth).Render(s.completion)
		detailCol := mutedStyle.Render(wrapText(s.detail, detailWidth))
		if i == selected {
			nameCol = accentStyle.Render("❯ " + lipgloss.NewStyle().Width(maxInt(1, nameWidth-2)).Render(s.completion))
		} else {
			nameCol = "  " + nameCol
		}
		lines = append(lines, nameCol+detailCol)
	}
	return padBlock(lipgloss.JoinVertical(lipgloss.Left, lines...), padX, boxWidth)
}
