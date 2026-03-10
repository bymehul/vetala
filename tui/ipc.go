package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// Send Msg to BubbleTea from the TS backend stdout
func startIPCReader(r io.Reader, p *tea.Program) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Bytes()

		var raw ServerMsg
		if err := json.Unmarshal(line, &raw); err != nil {
			continue // ignore malformed
		}

		switch raw.Tag {
		case "ready":
			var d DashboardData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgReady(d))
			}
		case "entry":
			var d EntryData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgEntry(d))
			}
		case "chunk":
			var d ChunkData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgChunk(d.Text))
			}
		case "flush":
			p.Send(MsgFlush{})
		case "activity":
			var d ActivityData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgActivity(d.Label))
			}
		case "spinner":
			var d SpinnerData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgSpinner{Label: d.Label})
			}
		case "status":
			var d StatusData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgStatus(d.Text))
			}
		case "prompt":
			var pd PromptData
			if json.Unmarshal(raw.Data, &pd) == nil {
				switch pd.PromptType {
				case "trust":
					p.Send(MsgPromptTrust(pd.Workspace))
				case "approval":
					p.Send(MsgPromptApproval(pd.Label))
				case "exit":
					p.Send(MsgPromptExit{})
				case "select":
					p.Send(MsgPromptSelect{Id: pd.Id, Title: pd.Title, Options: pd.Options})
				case "input":
					p.Send(MsgPromptInput{Id: pd.Id, Title: pd.Title, Placeholder: pd.Placeholder})
				}
			}
		case "clear":
			p.Send(MsgClear{})
		}
	}
}

func sendToBackend(w io.Writer, msg ClientMsg) {
	bytes, err := json.Marshal(msg)
	if err == nil {
		fmt.Fprintln(w, string(bytes))
	}
}

func sendInput(w io.Writer, text string) {
	sendToBackend(w, ClientMsg{Tag: "input", Data: InputData{Text: text}})
}

func sendTrust(w io.Writer, trusted bool) {
	sendToBackend(w, ClientMsg{Tag: "trust", Data: TrustData{Trusted: trusted}})
}

func sendApproval(w io.Writer, scope string) {
	sendToBackend(w, ClientMsg{Tag: "approval", Data: ApprovalData{Scope: scope}})
}

func sendInterrupt(w io.Writer) {
	sendToBackend(w, ClientMsg{Tag: "interrupt", Data: struct{}{}})
}

func sendExit(w io.Writer) {
	sendToBackend(w, ClientMsg{Tag: "exit", Data: struct{}{}})
	os.Exit(0)
}

func sendSubmitSelect(w io.Writer, id string, index int) {
	sendToBackend(w, ClientMsg{Tag: "submitSelect", Data: ClientMsgSubmitSelect{Id: id, Index: index}})
}

func sendSubmitInput(w io.Writer, id string, value string) {
	sendToBackend(w, ClientMsg{Tag: "submitInput", Data: ClientMsgSubmitInput{Id: id, Value: value}})
}
