package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// Send Msg to BubbleTea from the TS backend stdout
func startIPCReader(r io.Reader, w io.Writer, p *tea.Program) {
	scanner := bufio.NewScanner(r)
	// Increase buffer size for large messages (like full file content for diffs)
	const maxCapacity = 10 * 1024 * 1024 // 10MB
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, maxCapacity)
	searchCancels := map[string]context.CancelFunc{}
	var searchCancelMu sync.Mutex

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
				ctx, cancel := context.WithCancel(context.Background())
				searchCancelMu.Lock()
				if existing := searchCancels[d.Id]; existing != nil {
					existing()
				}
				searchCancels[d.Id] = cancel
				searchCancelMu.Unlock()
				go func() {
					defer func() {
						searchCancelMu.Lock()
						delete(searchCancels, d.Id)
						searchCancelMu.Unlock()
					}()
					matches := performFastSearch(ctx, d)
					if ctx.Err() == nil {
						sendSearchResult(w, d.Id, matches)
					}
				}()
			}
		case "cancel_search":
			var d ClientMsgCancelSearch
			if json.Unmarshal(raw.Data, &d) == nil {
				searchCancelMu.Lock()
				cancel := searchCancels[d.Id]
				delete(searchCancels, d.Id)
				searchCancelMu.Unlock()
				if cancel != nil {
					cancel()
				}
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
		case "discard":
			p.Send(MsgDiscardDraft{})
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
		case "skills":
			var d SkillsData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgSkills(d.Skills))
			}
		case "turn_state":
			var d TurnStateData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgTurnState(d))
			}
		case "plan_update":
			var d PlanUpdateData
			if json.Unmarshal(raw.Data, &d) == nil {
				p.Send(MsgPlanUpdate(d))
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

func performFastSearch(ctx context.Context, opts MsgFastSearch) []SearchMatch {
	var matches []SearchMatch
	var mu sync.Mutex

	maxFileBytes := fastSearchMaxFileBytes()
	maxLineBytes := fastSearchMaxLineBytes()
	sniffBytes := fastSearchSniffBytes()
	maxMatchesPerFile := fastSearchMaxMatchesPerFile()
	includeHidden := opts.IncludeHidden || pathContainsHiddenSegment(opts.Root)
	globMatchers := compileSearchGlobs(opts.Globs)

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
		".hg":          true,
		".svn":         true,
		"node_modules": true,
	}

	numWorkers := runtime.NumCPU()
	paths := make(chan string, 100)
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case path, ok := <-paths:
					if !ok {
						return
					}
					fileMatches := searchInFile(ctx, path, opts.Query, queryLower, re, maxLineBytes, sniffBytes, maxMatchesPerFile)
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
			}
		}()
	}

	_ = filepath.Walk(opts.Root, func(path string, info os.FileInfo, err error) error {
		if ctx.Err() != nil {
			return filepath.SkipAll
		}
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if path != opts.Root && skipDirs[info.Name()] {
				return filepath.SkipDir
			}
			if path != opts.Root && !includeHidden && strings.HasPrefix(info.Name(), ".") {
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

		if maxFileBytes > 0 && info.Size() > maxFileBytes {
			return nil
		}
		if path != opts.Root && !includeHidden && strings.HasPrefix(info.Name(), ".") {
			return nil
		}
		if len(globMatchers) > 0 {
			relativePath, err := filepath.Rel(opts.Root, path)
			if err != nil || !matchesSearchGlobs(relativePath, globMatchers) {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return filepath.SkipAll
		case paths <- path:
		}
		return nil
	})

	close(paths)
	wg.Wait()

	return matches
}

func searchInFile(ctx context.Context, path string, query string, queryLower string, re *regexp.Regexp, maxLineBytes int, sniffBytes int, maxMatches int) []SearchMatch {
	if ctx.Err() != nil {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var matches []SearchMatch
	reader := bufio.NewReader(f)
	if sniffBytes > 0 {
		sample, _ := reader.Peek(sniffBytes)
		if bytes.IndexByte(sample, 0) != -1 {
			return nil
		}
	}
	scanner := bufio.NewScanner(reader)
	if maxLineBytes > 0 {
		bufSize := minInt(64*1024, maxLineBytes)
		scanner.Buffer(make([]byte, 0, bufSize), maxLineBytes)
	}
	lineNum := 1
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
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
		if maxMatches > 0 && len(matches) >= maxMatches {
			break
		}
	}
	return matches
}

func pathContainsHiddenSegment(targetPath string) bool {
	for _, segment := range strings.Split(filepath.Clean(targetPath), string(filepath.Separator)) {
		if segment != "" && segment != "." && segment != ".." && strings.HasPrefix(segment, ".") {
			return true
		}
	}
	return false
}

func compileSearchGlobs(globs []string) []*regexp.Regexp {
	var matchers []*regexp.Regexp
	for _, glob := range globs {
		glob = strings.TrimSpace(glob)
		if glob == "" {
			continue
		}
		escaped := regexp.QuoteMeta(filepath.ToSlash(glob))
		escaped = strings.ReplaceAll(escaped, `\*\*/`, "___DSTAR_SLASH___")
		escaped = strings.ReplaceAll(escaped, `/\*\*`, "___SLASH_DSTAR___")
		escaped = strings.ReplaceAll(escaped, `\*\*`, "___DSTAR___")
		escaped = strings.ReplaceAll(escaped, `\*`, `[^/]*`)
		escaped = strings.ReplaceAll(escaped, "___DSTAR_SLASH___", `(.*\/)?`)
		escaped = strings.ReplaceAll(escaped, "___SLASH_DSTAR___", `(\/.*)?`)
		escaped = strings.ReplaceAll(escaped, "___DSTAR___", `.*`)
		pattern := `(?:^|/)` + escaped + `$`
		re, err := regexp.Compile(pattern)
		if err == nil {
			matchers = append(matchers, re)
		}
	}
	return matchers
}

func matchesSearchGlobs(relativePath string, matchers []*regexp.Regexp) bool {
	if len(matchers) == 0 {
		return true
	}
	normalized := filepath.ToSlash(relativePath)
	for _, matcher := range matchers {
		if matcher.MatchString(normalized) {
			return true
		}
	}
	return false
}
