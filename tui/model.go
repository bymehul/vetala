package main

import (
	"io"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
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

type model struct {
	// Layout
	width  int
	height int

	// IPC State
	dashboard DashboardData
	status    string
	ready     bool
	running   bool
	trusted   bool

	// Components
	viewport  viewport.Model
	textInput textinput.Model
	spinner   spinner.Model

	// Transcript
	entries        []EntryData
	lastPrintedIdx int
	liveBuffer     string
	activity       *string

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

func initialModel(w io.Writer) model {
	ti := textinput.New()
	ti.Placeholder = "Ask Vetala..."
	ti.Focus()
	ti.CharLimit = 2048
	ti.Width = 100

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("39")) // accent blue

	vp := viewport.New(100, 20)
	vp.YPosition = 0

	mi := textinput.New()
	mi.Focus()
	mi.Width = 60

	return model{
		textInput:      ti,
		spinner:        sp,
		modalInput:     mi,
		status:         "Connecting...",
		backendWriter:  w,
		lastPrintedIdx: 0,
	}
}

func (m model) Init() tea.Cmd {
	return textinput.Blink
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var (
		cmd  tea.Cmd
		cmds []tea.Cmd
	)

	switch msg := msg.(type) {
	case tea.KeyMsg:
		// Handle global keys first
		switch msg.Type {
		case tea.KeyCtrlC:
			// If running, send interrupt to pause the agent and trigger refinement prompt.
			// Otherwise, clear the current input to avoid accidental exits. Use Ctrl+D to exit.
			if m.running {
				sendInterrupt(m.backendWriter)
			} else {
				m.textInput.SetValue("")
			}
			return m, nil
		case tea.KeyCtrlD:
			m.modalState = ModalExit
			return m, nil
		}

		// Handle active modal input
		if m.modalState != ModalNone {
			if m.modalState == ModalInput {
				switch msg.Type {
				case tea.KeyEnter:
					return m.triggerActiveModal()
				case tea.KeyEsc, tea.KeyCtrlC:
					// Treat as submitting empty string to cancel
					sendSubmitInput(m.backendWriter, m.promptInputId, "")
					m.modalState = ModalNone
					m.modalJustClosed = true
					return m, resetModalClosedCmd()
				}
				m.modalInput, cmd = m.modalInput.Update(msg)
				return m, cmd
			}
			return m.handleModalKey(msg)
		}

		// Handle main input
		switch msg.Type {
		case tea.KeyEnter:
			v := strings.TrimSpace(m.textInput.Value())
			if v != "" {
				m.entries = append(m.entries, EntryData{Kind: "user", Text: v})
				m.textInput.SetValue("")

				isCommand := strings.HasPrefix(v, "/")
				if !isCommand {
					m.running = true
					m.status = "Running agent"
				}

				// Print immediately
				toPrint := m.entries[m.lastPrintedIdx:]
				m.lastPrintedIdx = len(m.entries)

				sendInput(m.backendWriter, v)
				return m, tea.Println(m.renderCardsToPrint(toPrint))
			}
			return m, nil
		case tea.KeyTab:
			// Autocomplete first slash suggestion
			v := m.textInput.Value()
			if strings.HasPrefix(v, "/") {
				matches := matchSlashCommands(v)
				if len(matches) > 0 {
					m.textInput.SetValue(matches[0].completion)
					m.textInput.SetCursor(len(matches[0].completion))
				}
			}
			return m, nil
		}

		// Forward to text input
		m.textInput, cmd = m.textInput.Update(msg)
		cmds = append(cmds, cmd)

	case tea.WindowSizeMsg:
		m.width = msg.Width - 2 // leave a small margin for terminal scrollbars
		m.height = msg.Height
		return m, nil

	// IPC Messages
	case MsgReady:
		m.dashboard = DashboardData(msg)
		m.ready = true
		m.status = "Ready"
		// Only show trust prompt and dashboard on first ready, not on /model re-sends
		if !m.trusted {
			m.modalState = ModalTrust
			m.trustWs = msg.Workspace
			cmds = append(cmds, tea.Println(m.renderDashboard()))
		}

	case MsgEntry:
		m.entries = append(m.entries, EntryData(msg))
		// Print immediately
		toPrint := m.entries[m.lastPrintedIdx:]
		m.lastPrintedIdx = len(m.entries)
		cmds = append(cmds, tea.Println(m.renderCardsToPrint(toPrint)))

	case MsgChunk:
		m.liveBuffer += string(msg)

	case MsgFlush:
		if m.liveBuffer != "" {
			m.entries = append(m.entries, EntryData{Kind: "assistant", Text: m.liveBuffer})
			m.liveBuffer = ""
			toPrint := m.entries[m.lastPrintedIdx:]
			m.lastPrintedIdx = len(m.entries)
			cmds = append(cmds, tea.Println(m.renderCardsToPrint(toPrint)))
		}

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
		// Reset running state for everything except explicit agent activity statuses
		if m.status != "Running agent" && m.status != "Stopping current turn" && m.status != "Running queued prompt" {
			m.running = false
			m.activity = nil
		}

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
		m.lastPrintedIdx = 0
		m.liveBuffer = ""
		m.activity = nil
		cmds = append(cmds, tea.ClearScreen)

	case MsgModalClosedReset:
		m.modalJustClosed = false

	case spinner.TickMsg:
		m.spinner, cmd = m.spinner.Update(msg)
		cmds = append(cmds, cmd)
	}

	return m, tea.Batch(cmds...)
}

func (m model) visibleSelectRows() int {
	height := m.height - 12
	if height < 4 {
		height = 4
	}
	if height > 12 {
		height = 12
	}
	return height
}

func (m model) handleModalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
	if msg.Type == tea.KeyUp || msg.String() == "k" || msg.String() == "up" {
		m.modalSelection--
		if m.modalSelection < 0 {
			m.modalSelection = 0 // we will calculate max below
		}
		if m.modalState == ModalSelect && m.modalSelection < m.modalScroll {
			m.modalScroll = m.modalSelection
		}
		return m, nil
	}
	if msg.Type == tea.KeyDown || msg.String() == "j" || msg.String() == "down" {
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

		switch msg.String() {
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

		switch msg.String() {
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

		switch msg.String() {
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

		switch msg.String() {
		case "enter":
			return m.triggerActiveModal()
		}
	}
	return m, nil
}

func (m model) triggerActiveModal() (tea.Model, tea.Cmd) {
	switch m.modalState {
	case ModalTrust:
		if m.modalSelection == 0 {
			m.modalState = ModalNone
			m.trusted = true
			m.status = "Ready"
			sendTrust(m.backendWriter, true)
			m.modalJustClosed = true
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
		return m, resetModalClosedCmd()
	case ModalExit:
		if m.modalSelection == 0 {
			sendExit(m.backendWriter)
			return m, tea.Quit
		} else {
			m.modalState = ModalNone
			m.modalJustClosed = true
			return m, resetModalClosedCmd()
		}

	case ModalSelect:
		sendSubmitSelect(m.backendWriter, m.promptSelectId, m.modalSelection)
		m.modalState = ModalNone
		m.modalJustClosed = true
		return m, resetModalClosedCmd()

	case ModalInput:
		sendSubmitInput(m.backendWriter, m.promptInputId, strings.TrimSpace(m.modalInput.Value()))
		m.modalState = ModalNone
		m.modalJustClosed = true
		return m, resetModalClosedCmd()
	}
	return m, nil
}
