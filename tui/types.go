package main

import (
	"encoding/json"
)

// ServerMsg is the raw envelope
type ServerMsg struct {
	Tag  string          `json:"tag"`
	Data json.RawMessage `json:"data"`
}

type DashboardData struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Workspace  string `json:"workspace"`
	SessionId  string `json:"sessionId"`
	UpdatedAt  string `json:"updatedAt"`
	IsLoggedIn bool   `json:"isLoggedIn"`
}

type EntryData struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type ChunkData struct {
	Text string `json:"text"`
}

type ActivityData struct {
	Label string `json:"label"`
}

type SpinnerData struct {
	Label *string `json:"label"` // null means stop spinner
}

type StatusData struct {
	Text string `json:"text"`
}

type SkillsData struct {
	Skills []string `json:"skills"`
}

type TurnStateData struct {
	Reasoning string `json:"reasoning"`
	Phase     string `json:"phase"`
}

type PromptData struct {
	PromptType string `json:"promptType"`
	// varying fields based on PromptType
	Workspace   string   `json:"workspace"`   // For "trust"
	Label       string   `json:"label"`       // For "approval"
	Id          string   `json:"id"`          // For "select" / "input"
	Title       string   `json:"title"`       // For "select" / "input"
	Options     []string `json:"options"`     // For "select"
	Placeholder string   `json:"placeholder"` // For "input"
}

type MsgComputeDiff struct {
	Id     string `json:"id"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type MsgFastSearch struct {
	Id            string   `json:"id"`
	Query         string   `json:"query"`
	Root          string   `json:"root"`
	Globs         []string `json:"globs"`
	Limit         int      `json:"limit"`
	Regex         bool     `json:"regex"`
	IncludeHidden bool     `json:"includeHidden"`
}

type MsgReady DashboardData
type MsgEntry EntryData
type MsgChunk string
type MsgFlush struct{}
type MsgDiscardDraft struct{}
type MsgActivity string
type MsgSpinner struct{ Label *string }
type MsgStatus string
type MsgSkills []string
type MsgTurnState TurnStateData
type MsgPromptTrust string    // workspace
type MsgPromptApproval string // label
type MsgPromptExit struct{}

type MsgPromptSelect struct {
	Id      string
	Title   string
	Options []string
}

type MsgPromptInput struct {
	Id          string
	Title       string
	Placeholder string
}

type MsgClear struct{}

type ClientMsg struct {
	Tag  string `json:"tag"`
	Data any    `json:"data"`
}

type InputData struct {
	Text string `json:"text"`
}

type TrustData struct {
	Trusted bool `json:"trusted"`
}

type ApprovalData struct {
	Scope string `json:"scope"`
}

type ClientMsgSubmitSelect struct {
	Id    string `json:"id"`
	Index int    `json:"index"`
}

type ClientMsgSubmitInput struct {
	Id    string `json:"id"`
	Value string `json:"value"`
}

type ClientMsgDiffResult struct {
	Id   string `json:"id"`
	Diff string `json:"diff"`
}

type ClientMsgCancelSearch struct {
	Id string `json:"id"`
}

type SearchMatch struct {
	FilePath   string `json:"filePath"`
	LineNumber int    `json:"lineNumber"`
	LineText   string `json:"lineText"`
}

type ClientMsgSearchResult struct {
	Id      string        `json:"id"`
	Matches []SearchMatch `json:"matches"`
}
