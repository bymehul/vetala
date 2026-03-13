package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// Send Msg to BubbleTea from the TS backend stdout
func startIPCReader(r io.Reader, w io.Writer, p *tea.Program) {
	scanner := bufio.NewScanner(r)
	// Increase buffer size for large messages (like full file content for diffs)
	const maxCapacity = 10 * 1024 * 1024 // 10MB
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, maxCapacity)

	for scanner.Scan() {
		line := scanner.Bytes()

		var raw ServerMsg
		if err := json.Unmarshal(line, &raw); err != nil {
			continue // ignore malformed
		}

		switch raw.Tag {
		case "compute_diff":
			var d MsgComputeDiff
			if json.Unmarshal(raw.Data, &d) == nil {
				go func() {
					dmp := diffmatchpatch.New()
					diffs := dmp.DiffMain(d.Before, d.After, false)
					diffStr := dmp.DiffPrettyText(diffs)
					sendDiffResult(w, d.Id, diffStr)
				}()
			}
		case "fast_search":
			var d MsgFastSearch
			if json.Unmarshal(raw.Data, &d) == nil {
				go func() {
					matches := performFastSearch(d)
					sendSearchResult(w, d.Id, matches)
				}()
			}
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

func sendDiffResult(w io.Writer, id string, diff string) {
	sendToBackend(w, ClientMsg{Tag: "diffResult", Data: ClientMsgDiffResult{Id: id, Diff: diff}})
}

func sendSearchResult(w io.Writer, id string, matches []SearchMatch) {
	sendToBackend(w, ClientMsg{Tag: "searchResult", Data: ClientMsgSearchResult{Id: id, Matches: matches}})
}

func performFastSearch(opts MsgFastSearch) []SearchMatch {
	var matches []SearchMatch
	var mu sync.Mutex

	var re *regexp.Regexp
	if opts.Regex {
		var err error
		re, err = regexp.Compile(opts.Query)
		if err != nil {
			return nil
		}
	}

	queryLower := strings.ToLower(opts.Query)

	// Simple skip list
	skipDirs := map[string]bool{
		".git":         true,
		"node_modules": true,
		"dist":         true,
		"build":        true,
	}

	numWorkers := runtime.NumCPU()
	paths := make(chan string, 100)
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range paths {
				fileMatches := searchInFile(path, opts.Query, queryLower, re)
				if len(fileMatches) > 0 {
					mu.Lock()
					if len(matches) < opts.Limit {
						remaining := opts.Limit - len(matches)
						if len(fileMatches) > remaining {
							matches = append(matches, fileMatches[:remaining]...)
						} else {
							matches = append(matches, fileMatches...)
						}
					}
					mu.Unlock()
				}
			}
		}()
	}

	_ = filepath.Walk(opts.Root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if skipDirs[info.Name()] || strings.HasPrefix(info.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}

		mu.Lock()
		atLimit := len(matches) >= opts.Limit
		mu.Unlock()

		if atLimit {
			return filepath.SkipAll
		}

		paths <- path
		return nil
	})

	close(paths)
	wg.Wait()

	return matches
}

func searchInFile(path string, query string, queryLower string, re *regexp.Regexp) []SearchMatch {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var matches []SearchMatch
	scanner := bufio.NewScanner(f)
	lineNum := 1
	for scanner.Scan() {
		line := scanner.Text()
		isMatch := false
		if re != nil {
			isMatch = re.MatchString(line)
		} else {
			isMatch = strings.Contains(strings.ToLower(line), queryLower)
		}

		if isMatch {
			matches = append(matches, SearchMatch{
				FilePath:   path,
				LineNumber: lineNum,
				LineText:   line,
			})
		}
		lineNum++
		if len(matches) > 100 { // limit per file
			break
		}
	}
	return matches
}
