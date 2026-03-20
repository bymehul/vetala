package main

import (
	"io"
	"strings"

	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/atotto/clipboard"
)

type ModalState int

const (
	ModalNone ModalState = iota
	ModalTrust
	ModalApproval
	ModalExit
	ModalPause
	ModalSelect
	ModalInput
)

type markdownRenderer interface {
	Render(string) (string, error)
}

type deferredUpdate struct {
	kind  string
	entry EntryData
	chunk string
}

type model struct {
	// Layout
	width  int
	height int

	// IPC State
	dashboard     DashboardData
	status        string
	ready         bool
	running       bool
	trusted       bool
	skillLabels   []string
	turnReasoning string
	turnPhase     string
	currentPlan   PlanUpdateData

	// Components
	viewport viewport.Model
	textArea textarea.Model
	spinner  spinner.Model

	// Transcript
	entries            []EntryData
	liveBuffer         string
	activity           *string
	autoScroll         bool
	transcriptDirty    bool
	pendingUpdates     []deferredUpdate
	showToolDetails    bool
	showDashboard      bool
	hasDarkBackground  bool
	bgKnown            bool
	entriesDirty       bool
	dashboardDirty     bool
	entriesWidth       int
	entriesHeight      int
	entriesToolDetails bool
	dashboardWidth     int
	renderedEntries    string
	renderedDashboard  string
	glamourRenderer    markdownRenderer
	glamourWidth       int
	glamourDarkTheme   bool
	lastLiveEntry      bool

	toggleToolKeys []string
	copyLastKeys   []string
	copyTurnKeys   []string
	keyDebug       bool
	lastKeyDebug   string
	mouseMode      tea.MouseMode
	altScreen      bool

	// Modals
	modalState     ModalState
	modalSelection int
	trustWs        string
	approvalData   string

	promptSelectId      string
	promptSelectTitle   string
	promptSelectOptions []string
	modalSelectReset    bool

	promptInputId    string
	promptInputTitle string
	promptInputText  string
	modalInput       textinput.Model
	modalScroll      int

	modalJustClosed bool

	// IPC Writer
	backendWriter io.Writer
}

type MsgModalClosedReset struct{}

func resetModalClosedCmd() tea.Cmd {
	return func() tea.Msg {
		return MsgModalClosedReset{}
	}
}

func initialModel(w io.Writer) *model {
	ta := textarea.New()
	ta.Prompt = ""
	ta.Placeholder = "Ask Vetala..."
	ta.ShowLineNumbers = false
	ta.Focus()
	ta.CharLimit = 2048
	ta.SetWidth(100)
	ta.SetHeight(1)
	ta.SetVirtualCursor(true)
	ta.KeyMap.InsertNewline.SetEnabled(false)

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("39")) // accent blue

	vp := viewport.New(
		viewport.WithWidth(100),
		viewport.WithHeight(20),
	)
	vp.YPosition = 0
	vp.MouseWheelEnabled = true

	mi := textinput.New()
	mi.Prompt = ""
	mi.Focus()
	mi.SetWidth(60)
	mi.SetVirtualCursor(true)

	return &model{
		textArea:           ta,
		spinner:            sp,
		viewport:           vp,
		modalInput:         mi,
		status:             "Connecting...",
		backendWriter:      w,
		autoScroll:         true,
		transcriptDirty:    true,
		entriesDirty:       true,
		dashboardDirty:     true,
		showToolDetails:    uiToolDetailsDefault(),
		entriesToolDetails: uiToolDetailsDefault(),
		toggleToolKeys:     uiToolToggleKeys(),
		copyLastKeys:       uiCopyLastKeys(),
		copyTurnKeys:       uiCopyTurnKeys(),
		keyDebug:           uiKeyDebugEnabled(),
		mouseMode:          uiMouseMode(),
		altScreen:          uiAltScreen(),
	}
}

func (m *model) Init() tea.Cmd {
	return tea.Batch(
		textarea.Blink,
		func() tea.Msg { return tea.RequestBackgroundColor() },
	)
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var (
		cmd  tea.Cmd
		cmds []tea.Cmd
	)

	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		key := msg.String()
		keystroke := msg.Keystroke()
		if m.keyDebug {
			m.lastKeyDebug = "key: " + key
			if keystroke != "" && keystroke != key {
				m.lastKeyDebug += " · stroke: " + keystroke
			}
		}
		// Handle global keys first
		switch key {
		case "ctrl+c":
			// If running, send interrupt to pause the agent and trigger refinement prompt.
			// Otherwise, clear the current input to avoid accidental exits. Use Ctrl+D to exit.
			if m.running {
				m.modalState = ModalPause
				m.status = "Stopping current turn"
				sendInterrupt(m.backendWriter)
			} else {
				m.textArea.SetValue("")
			}
			return m, nil
		case "ctrl+d":
			m.modalState = ModalExit
			return m, nil
		}
		if m.isToggleToolKey(key) || (keystroke != key && m.isToggleToolKey(keystroke)) {
			m.showToolDetails = !m.showToolDetails
			m.entriesDirty = true
			m.transcriptDirty = true
			return m, nil
		}
		if m.isCopyLastKey(key) || (keystroke != key && m.isCopyLastKey(keystroke)) {
			m.copyLastAssistant()
			return m, nil
		}
		if m.isCopyTurnKey(key) || (keystroke != key && m.isCopyTurnKey(keystroke)) {
			m.copyLastTurnLog()
			return m, nil
		}

		if m.handleScrollKey(key) {
			return m, nil
		}

		// Handle active modal input
		if m.modalState != ModalNone {
			if m.modalState == ModalInput {
				switch key {
				case "enter":
					return m.triggerActiveModal()
				case "esc", "ctrl+c":
					// Treat as submitting empty string to cancel
					sendSubmitInput(m.backendWriter, m.promptInputId, "")
					m.modalState = ModalNone
					m.modalJustClosed = true
					m.flushPendingUpdates()
					return m, resetModalClosedCmd()
				}
				m.modalInput, cmd = m.modalInput.Update(msg)
				return m, cmd
			}
			return m.handleModalKey(key)
		}

		// Handle main input
		switch key {
		case "enter":
			v := strings.TrimSpace(m.textArea.Value())
			if v != "" {
				m.currentPlan = PlanUpdateData{}
				m.entries = append(m.entries, EntryData{Kind: "user", Text: v})
				m.trimEntries()
				m.transcriptDirty = true
				m.autoScroll = true
				m.textArea.SetValue("")

				isCommand := strings.HasPrefix(v, "/")
				if !isCommand {
					m.running = true
					m.status = "Running agent"
				}

				sendInput(m.backendWriter, v)
				return m, nil
			}
			return m, nil
		case "tab":
			// Autocomplete first slash suggestion
			v := m.textArea.Value()
			if strings.HasPrefix(v, "/") {
				matches := matchSlashCommands(v)
				if len(matches) > 0 {
					m.textArea.SetValue(matches[0].completion)
					m.textArea.MoveToEnd()
				}
			}
			return m, nil
		}

		// Forward to text input
		m.textArea, cmd = m.textArea.Update(msg)
		cmds = append(cmds, cmd)

	case tea.MouseMsg:
		if m.modalState == ModalNone {
			m.viewport, cmd = m.viewport.Update(msg)
			m.autoScroll = m.viewport.AtBottom()
			cmds = append(cmds, cmd)
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.updateInputWidths()
		m.entriesDirty = true
		m.dashboardDirty = true
		m.transcriptDirty = true
		return m, nil

	case tea.BackgroundColorMsg:
		m.hasDarkBackground = msg.IsDark()
		m.bgKnown = true
		m.entriesDirty = true
		m.dashboardDirty = true
		m.transcriptDirty = true
		return m, nil

	// IPC Messages
	case MsgReady:
		m.dashboard = DashboardData(msg)
		m.ready = true
		m.status = "Ready"
		m.showDashboard = true
		m.dashboardDirty = true
		// Only show trust prompt and dashboard on first ready, not on /model re-sends
		if !m.trusted {
			m.modalState = ModalTrust
			m.trustWs = msg.Workspace
			m.showDashboard = true
		}
		m.transcriptDirty = true

	case MsgEntry:
		entry := EntryData(msg)
		if m.modalState != ModalNone {
			m.queueUpdate(deferredUpdate{kind: "entry", entry: entry})
			return m, nil
		}
		m.appendEntry(entry)

	case MsgChunk:
		if m.modalState != ModalNone {
			m.queueUpdate(deferredUpdate{kind: "chunk", chunk: string(msg)})
			return m, nil
		}
		m.appendLiveChunk(string(msg))

	case MsgFlush:
		if m.modalState != ModalNone {
			m.queueUpdate(deferredUpdate{kind: "flush"})
			return m, nil
		}
		m.flushLiveBuffer()

	case MsgDiscardDraft:
		if m.modalState != ModalNone {
			m.queueUpdate(deferredUpdate{kind: "discard"})
			return m, nil
		}
		m.discardLiveBuffer()

	case MsgActivity:
		if string(msg) == "" {
			m.activity = nil
		} else {
			lbl := string(msg)
			m.activity = &lbl
		}

	case MsgSpinner:
		if msg.Label != nil {
			cmds = append(cmds, m.spinner.Tick)
		} else {
			// Spinner stopped — clear activity
			m.activity = nil
		}

	case MsgStatus:
		m.status = string(msg)
		m.dashboardDirty = true
		// Reset running state for everything except explicit agent activity statuses
		if m.status != "Running agent" && m.status != "Stopping current turn" && m.status != "Running queued prompt" {
			m.running = false
			m.activity = nil
			if m.modalState == ModalPause {
				m.modalState = ModalNone
			}
		}
		m.transcriptDirty = true

	case MsgSkills:
		m.skillLabels = append([]string(nil), msg...)
		m.dashboardDirty = true
		m.transcriptDirty = true

	case MsgTurnState:
		m.turnReasoning = msg.Reasoning
		m.turnPhase = msg.Phase
		m.dashboardDirty = true
		m.transcriptDirty = true

	case MsgPlanUpdate:
		m.currentPlan = PlanUpdateData(msg)
		m.dashboardDirty = true
		m.transcriptDirty = true

	case MsgPromptTrust:
		m.modalState = ModalTrust
		m.trustWs = string(msg)

	case MsgPromptApproval:
		m.modalState = ModalApproval
		m.approvalData = string(msg)

	case MsgPromptExit:
		m.modalState = ModalExit

	case MsgPromptSelect:
		m.modalState = ModalSelect
		m.promptSelectId = msg.Id
		m.promptSelectTitle = msg.Title
		m.promptSelectOptions = msg.Options
		m.modalSelection = 0
		m.modalScroll = 0
		m.modalSelectReset = true

	case MsgPromptInput:
		m.modalState = ModalInput
		m.promptInputId = msg.Id
		m.promptInputTitle = msg.Title
		m.promptInputText = msg.Placeholder
		m.modalInput.SetValue("")
		m.modalInput.Focus()

	case MsgClear:
		m.entries = nil
		m.liveBuffer = ""
		m.activity = nil
		m.currentPlan = PlanUpdateData{}
		m.entriesDirty = true
		m.transcriptDirty = true
		m.autoScroll = true
		m.viewport.SetContent("")
		m.viewport.GotoTop()
		cmds = append(cmds, tea.ClearScreen)

	case MsgModalClosedReset:
		m.modalJustClosed = false

	case spinner.TickMsg:
		m.spinner, cmd = m.spinner.Update(msg)
		cmds = append(cmds, cmd)

	case tea.PasteMsg:
		if m.modalState == ModalInput {
			m.modalInput, cmd = m.modalInput.Update(msg)
			return m, cmd
		}
		if m.modalState == ModalNone {
			m.textArea, cmd = m.textArea.Update(msg)
			return m, cmd
		}
		return m, nil

	default:
		if m.modalState == ModalInput {
			m.modalInput, cmd = m.modalInput.Update(msg)
			return m, cmd
		}
		if m.modalState == ModalNone {
			m.textArea, cmd = m.textArea.Update(msg)
			return m, cmd
		}
	}

	return m, tea.Batch(cmds...)
}

func (m *model) visibleSelectRows() int {
	return uiSelectVisibleRows(m.height)
}

func (m *model) isToggleToolKey(key string) bool {
	for _, k := range m.toggleToolKeys {
		if k == key {
			return true
		}
	}
	return false
}

func (m *model) isCopyLastKey(key string) bool {
	for _, k := range m.copyLastKeys {
		if k == key {
			return true
		}
	}
	return false
}

func (m *model) isCopyTurnKey(key string) bool {
	for _, k := range m.copyTurnKeys {
		if k == key {
			return true
		}
	}
	return false
}

func (m *model) copyLastAssistant() {
	text := m.lastAssistantText()
	if text == "" {
		m.status = "No assistant reply to copy"
		m.dashboardDirty = true
		return
	}
	if err := clipboard.WriteAll(text); err != nil {
		m.status = "Copy failed"
		m.dashboardDirty = true
		return
	}
	m.status = "Copied last reply"
	m.dashboardDirty = true
}

func (m *model) copyLastTurnLog() {
	text := m.lastTurnLogText()
	if text == "" {
		m.status = "No turn log to copy"
		m.dashboardDirty = true
		return
	}
	if err := clipboard.WriteAll(text); err != nil {
		m.status = "Copy failed"
		m.dashboardDirty = true
		return
	}
	m.status = "Copied last turn log"
	m.dashboardDirty = true
}

func (m *model) lastAssistantText() string {
	for i := len(m.entries) - 1; i >= 0; i-- {
		if m.entries[i].Kind == "assistant" {
			return m.entries[i].Text
		}
	}
	return ""
}

func (m *model) lastTurnLogText() string {
	start := 0
	foundUser := false
	for i := len(m.entries) - 1; i >= 0; i-- {
		if m.entries[i].Kind == "user" {
			start = i
			foundUser = true
			break
		}
	}
	if !foundUser && len(m.entries) == 0 && len(m.currentPlan.Steps) == 0 && strings.TrimSpace(m.liveBuffer) == "" && m.activity == nil {
		return ""
	}

	var sections []string
	for _, entry := range m.entries[start:] {
		if block := formatLogSection(entry.Kind, entry.Text); block != "" {
			sections = append(sections, block)
		}
	}

	if plan := strings.TrimSpace(m.lastTurnPlanText()); plan != "" {
		sections = append(sections, plan)
	}

	if m.activity != nil {
		if block := formatLogSection("doing", *m.activity); block != "" {
			sections = append(sections, block)
		}
	} else if m.running {
		if block := formatLogSection("doing", "Thinking..."); block != "" {
			sections = append(sections, block)
		}
	}

	if block := formatLogSection("assistant", strings.TrimSpace(m.liveBuffer)); block != "" {
		sections = append(sections, block)
	}

	var trailer []string
	if len(m.skillLabels) > 0 {
		trailer = append(trailer, "skills: "+strings.Join(m.skillLabels, ", "))
	}
	if status := strings.TrimSpace(m.statusLine()); status != "" {
		trailer = append(trailer, status)
	}
	if len(trailer) > 0 {
		sections = append(sections, strings.Join(trailer, "\n"))
	}

	return strings.TrimSpace(strings.Join(sections, "\n\n"))
}

func (m *model) lastTurnPlanText() string {
	if len(m.currentPlan.Steps) == 0 {
		return ""
	}

	title := strings.TrimSpace(m.currentPlan.Title)
	if title == "" {
		title = "Plan"
	}
	lines := []string{title}
	if explanation := strings.TrimSpace(m.currentPlan.Explanation); explanation != "" {
		lines = append(lines, explanation)
	}
	for _, step := range m.currentPlan.Steps {
		lines = append(lines, plainPlanMarker(step.Status)+" "+strings.TrimSpace(step.Label))
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func formatLogSection(label string, text string) string {
	body := strings.TrimSpace(text)
	if body == "" {
		return ""
	}
	return label + "\n" + indentLogBlock(body)
}

func indentLogBlock(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = "  " + line
	}
	return strings.Join(lines, "\n")
}

func plainPlanMarker(status string) string {
	switch status {
	case "completed":
		return "[x]"
	case "in_progress":
		return "[>]"
	default:
		return "[ ]"
	}
}

func (m *model) handleModalKey(key string) (tea.Model, tea.Cmd) {
	if m.modalState == ModalSelect && m.modalSelectReset {
		m.modalSelectReset = false
	}
	// Determine max bounds for current modal
	maxSel := 0
	switch m.modalState {
	case ModalTrust:
		maxSel = 1
	case ModalApproval:
		maxSel = 2
	case ModalExit:
		maxSel = 1
	case ModalSelect:
		maxSel = len(m.promptSelectOptions) - 1
		if maxSel < 0 {
			maxSel = 0
		}
	}

	// Global up/down handling for modal selection
	if key == "up" || key == "k" {
		m.modalSelection--
		if m.modalSelection < 0 {
			m.modalSelection = 0 // we will calculate max below
		}
		if m.modalState == ModalSelect && m.modalSelection < m.modalScroll {
			m.modalScroll = m.modalSelection
		}
		return m, nil
	}
	if key == "down" || key == "j" {
		m.modalSelection++
		if m.modalSelection > maxSel {
			m.modalSelection = maxSel
		}
		if m.modalState == ModalSelect {
			visible := m.visibleSelectRows()
			if m.modalSelection >= m.modalScroll+visible {
				m.modalScroll = m.modalSelection - visible + 1
			}
		}
		return m, nil
	}

	switch m.modalState {
	case ModalTrust:
		// max selection index = 1 (Yes, No)
		if m.modalSelection > 1 {
			m.modalSelection = 1
		}

		switch key {
		case "1":
			m.modalSelection = 0
			// fallthrough in Go needs explicit call or logic, let's just trigger
			return m.triggerActiveModal()
		case "2":
			m.modalSelection = 1
			return m.triggerActiveModal()
		case "enter":
			return m.triggerActiveModal()
		}
	case ModalApproval:
		if m.modalSelection > 2 {
			m.modalSelection = 2
		}

		switch key {
		case "1":
			m.modalSelection = 0
			return m.triggerActiveModal()
		case "2":
			m.modalSelection = 1
			return m.triggerActiveModal()
		case "3":
			m.modalSelection = 2
			return m.triggerActiveModal()
		case "enter":
			return m.triggerActiveModal()
		}
	case ModalExit:
		if m.modalSelection > 1 {
			m.modalSelection = 1
		}

		switch key {
		case "1":
			m.modalSelection = 0
			return m.triggerActiveModal()
		case "2", "esc":
			m.modalSelection = 1
			return m.triggerActiveModal()
		case "enter":
			return m.triggerActiveModal()
		}

	case ModalSelect:
		if m.modalSelection > maxSel {
			m.modalSelection = maxSel
		}

		switch key {
		case "enter":
			return m.triggerActiveModal()
		}
	}
	return m, nil
}

func (m *model) triggerActiveModal() (tea.Model, tea.Cmd) {
	switch m.modalState {
	case ModalTrust:
		if m.modalSelection == 0 {
			m.modalState = ModalNone
			m.trusted = true
			m.status = "Ready"
			m.transcriptDirty = true
			sendTrust(m.backendWriter, true)
			m.modalJustClosed = true
			m.flushPendingUpdates()
			return m, resetModalClosedCmd()
		} else {
			sendExit(m.backendWriter)
			return m, tea.Quit
		}
	case ModalApproval:
		m.modalState = ModalNone
		if m.modalSelection == 0 {
			sendApproval(m.backendWriter, "once")
		} else if m.modalSelection == 1 {
			sendApproval(m.backendWriter, "session")
		} else {
			sendApproval(m.backendWriter, "deny")
		}
		m.modalJustClosed = true
		m.flushPendingUpdates()
		return m, resetModalClosedCmd()
	case ModalExit:
		if m.modalSelection == 0 {
			sendExit(m.backendWriter)
			return m, tea.Quit
		} else {
			m.modalState = ModalNone
			m.modalJustClosed = true
			m.flushPendingUpdates()
			return m, resetModalClosedCmd()
		}

	case ModalSelect:
		sendSubmitSelect(m.backendWriter, m.promptSelectId, m.modalSelection)
		m.modalState = ModalNone
		m.modalJustClosed = true
		m.flushPendingUpdates()
		return m, resetModalClosedCmd()

	case ModalInput:
		sendSubmitInput(m.backendWriter, m.promptInputId, strings.TrimSpace(m.modalInput.Value()))
		m.modalState = ModalNone
		m.modalJustClosed = true
		m.flushPendingUpdates()
		return m, resetModalClosedCmd()
	}
	return m, nil
}

func (m *model) handleScrollKey(key string) bool {
	switch key {
	case "pgup", "pageup":
		m.viewport.PageUp()
	case "pgdown", "pagedown":
		m.viewport.PageDown()
	case "home":
		m.viewport.GotoTop()
	case "end":
		m.viewport.GotoBottom()
	default:
		return false
	}
	m.autoScroll = m.viewport.AtBottom()
	return true
}

func (m *model) updateInputWidths() {
	if m.width <= 0 {
		return
	}
	prefixWidth := lipgloss.Width("❯ ")
	padX := uiContainerPadding(m.width)
	innerWidth := maxInt(10, m.transcriptBoxWidth()-(padX*2))
	inputPad := uiInputPaddingX(m.width)
	textWidth := maxInt(10, innerWidth-(inputPad*2)-prefixWidth)
	m.textArea.SetWidth(textWidth)
	m.textArea.MaxHeight = uiInputMaxRows(m.height)

	modalWidth := maxInt(10, m.modalContentWidth())
	m.modalInput.SetWidth(modalWidth)
}

func (m *model) trimEntries() {
	maxEntries := uiMaxEntries(m.height)
	if maxEntries <= 0 || len(m.entries) <= maxEntries {
		return
	}
	m.entries = m.entries[len(m.entries)-maxEntries:]
}

func (m *model) appendEntry(entry EntryData) {
	if entry.Kind != "assistant" {
		m.lastLiveEntry = false
	}

	if entry.Kind == "assistant" && m.lastLiveEntry && len(m.entries) > 0 {
		lastIdx := len(m.entries) - 1
		last := m.entries[lastIdx]
		if last.Kind == "assistant" {
			m.entries[lastIdx] = entry
			m.lastLiveEntry = false
			m.entriesDirty = true
			m.transcriptDirty = true
			return
		}
	}

	if entry.Kind == "assistant" {
		m.liveBuffer = ""
		m.lastLiveEntry = false
	}
	m.entries = append(m.entries, entry)
	m.trimEntries()
	m.entriesDirty = true
	m.transcriptDirty = true
}

func (m *model) appendLiveChunk(chunk string) {
	if chunk == "" {
		return
	}
	m.liveBuffer += chunk
	maxChars := uiLivePreviewMaxChars(m.width, m.height)
	if maxChars > 0 && len(m.liveBuffer) > maxChars {
		m.liveBuffer = m.liveBuffer[len(m.liveBuffer)-maxChars:]
	}
}

func (m *model) flushLiveBuffer() {
	if m.liveBuffer == "" {
		return
	}
	m.entries = append(m.entries, EntryData{Kind: "assistant", Text: m.liveBuffer})
	m.trimEntries()
	m.liveBuffer = ""
	m.lastLiveEntry = true
	m.entriesDirty = true
	m.transcriptDirty = true
}

func (m *model) discardLiveBuffer() {
	if m.liveBuffer == "" {
		return
	}
	m.liveBuffer = ""
}

func (m *model) queueUpdate(update deferredUpdate) {
	m.pendingUpdates = append(m.pendingUpdates, update)
}

func (m *model) flushPendingUpdates() {
	if len(m.pendingUpdates) == 0 {
		return
	}
	for _, update := range m.pendingUpdates {
		switch update.kind {
		case "entry":
			m.appendEntry(update.entry)
		case "chunk":
			m.appendLiveChunk(update.chunk)
		case "flush":
			m.flushLiveBuffer()
		case "discard":
			m.discardLiveBuffer()
		}
	}
	m.pendingUpdates = nil
}
