package main

import (
	"fmt"
	"os"
	"os/exec"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	if len(os.Args) < 3 || os.Args[1] != "--workspace" {
		fmt.Println("Usage: tui --workspace <dir>")
		os.Exit(1)
	}
	workspace := os.Args[2]

	// Start TS Backend
	// Using npx tsx src/ipc-backend.ts --workspace <dir>
	// We run from the root, not tui/
	cmd := exec.Command("npx", "tsx", "src/ipc-backend.ts", "--workspace", workspace)

	// Set CWD to parent dir (project root)
	cmd.Dir = "../"

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Println("Error creating stdout pipe:", err)
		os.Exit(1)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		fmt.Println("Error creating stdin pipe:", err)
		os.Exit(1)
	}

	cmd.Stderr = os.Stderr // Pipe backend errors directly to UI terminal (might break lipgloss, but useful for crash logs)

	if err := cmd.Start(); err != nil {
		fmt.Println("Error starting backend:", err)
		os.Exit(1)
	}

	m := initialModel(stdin)
	p := tea.NewProgram(
		m,
	)

	// Start the reader goroutine
	go startIPCReader(stdout, p)

	// Wait for backend to exit and quit the TUI
	go func() {
		cmd.Wait()
		p.Quit()
	}()

	if _, err := p.Run(); err != nil {
		fmt.Println("Error running program:", err)
		os.Exit(1)
	}
}
