package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type backendCommand struct {
	Dir  string
	File string
	Args []string
}

func main() {
	if len(os.Args) < 3 || os.Args[1] != "--workspace" {
		fmt.Println("Usage: tui --workspace <dir>")
		os.Exit(1)
	}
	workspace := os.Args[2]

	executablePath, err := os.Executable()
	if err != nil {
		fmt.Println("Error locating TUI executable:", err)
		os.Exit(1)
	}

	backend, err := resolveBackendCommand(executablePath, workspace)
	if err != nil {
		fmt.Println("Error resolving backend:", err)
		os.Exit(1)
	}

	cmd := exec.Command(backend.File, backend.Args...)
	cmd.Dir = backend.Dir

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

	if os.Getenv("VETALA_SMOKE_TEST") == "1" {
		if err := runSmokeTest(stdout, stdin, cmd); err != nil {
			fmt.Println("Smoke test failed:", err)
			os.Exit(1)
		}
		fmt.Println("Vetala smoke test passed.")
		return
	}

	m := initialModel(stdin)
	p := tea.NewProgram(
		m,
	)

	// Start the reader goroutine
	go startIPCReader(stdout, stdin, p)

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

func resolveBackendCommand(executablePath string, workspace string) (backendCommand, error) {
	packageRoot := resolvePackageRoot(executablePath)
	distBackend := filepath.Join(packageRoot, "dist", "src", "ipc-backend.js")

	if fileExists(distBackend) {
		return backendCommand{
			Dir:  packageRoot,
			File: "node",
			Args: []string{distBackend, "--workspace", workspace},
		}, nil
	}

	sourceBackend := filepath.Join(packageRoot, "src", "ipc-backend.ts")
	if fileExists(sourceBackend) {
		return backendCommand{
			Dir:  packageRoot,
			File: "npx",
			Args: []string{"tsx", sourceBackend, "--workspace", workspace},
		}, nil
	}

	return backendCommand{}, fmt.Errorf(
		"could not find Vetala backend. looked for %s and %s",
		distBackend,
		sourceBackend,
	)
}

func resolvePackageRoot(executablePath string) string {
	if resolvedPath, err := filepath.EvalSymlinks(executablePath); err == nil {
		executablePath = resolvedPath
	}

	return filepath.Dir(filepath.Dir(executablePath))
}

func fileExists(target string) bool {
	info, err := os.Stat(target)
	if err != nil {
		return false
	}

	return !info.IsDir()
}

func runSmokeTest(stdout io.Reader, stdin io.WriteCloser, cmd *exec.Cmd) error {
	errCh := make(chan error, 1)

	go func() {
		errCh <- waitForBackendReady(stdout)
	}()

	select {
	case err := <-errCh:
		if err != nil {
			terminateProcess(cmd)
			return err
		}
	case <-time.After(15 * time.Second):
		terminateProcess(cmd)
		return errors.New("timed out waiting for backend ready message")
	}

	sendToBackend(stdin, ClientMsg{Tag: "exit", Data: struct{}{}})
	_ = stdin.Close()

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- cmd.Wait()
	}()

	select {
	case err := <-waitCh:
		return err
	case <-time.After(5 * time.Second):
		terminateProcess(cmd)
		return errors.New("timed out waiting for backend exit after smoke test")
	}
}

func waitForBackendReady(stdout io.Reader) error {
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		var msg ServerMsg
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}

		if msg.Tag == "ready" {
			return nil
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading backend output: %w", err)
	}

	return errors.New("backend exited before sending ready")
}

func terminateProcess(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}

	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
}
