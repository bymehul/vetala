package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestResolveBackendCommandPrefersDistBackend(t *testing.T) {
	packageRoot := t.TempDir()
	distBackend := filepath.Join(packageRoot, "dist", "src", "ipc-backend.js")
	sourceBackend := filepath.Join(packageRoot, "src", "ipc-backend.ts")
	executablePath := filepath.Join(packageRoot, "tui", "vetala")

	writeTestFile(t, distBackend)
	writeTestFile(t, sourceBackend)

	command, err := resolveBackendCommand(executablePath, "/tmp/workspace")
	if err != nil {
		t.Fatalf("resolveBackendCommand returned error: %v", err)
	}

	if command.Dir != packageRoot {
		t.Fatalf("expected command dir %q, got %q", packageRoot, command.Dir)
	}

	if command.File != "node" {
		t.Fatalf("expected command file %q, got %q", "node", command.File)
	}

	expectedArgs := []string{distBackend, "--workspace", "/tmp/workspace"}
	if !reflect.DeepEqual(command.Args, expectedArgs) {
		t.Fatalf("expected args %v, got %v", expectedArgs, command.Args)
	}
}

func TestResolveBackendCommandFallsBackToSourceBackend(t *testing.T) {
	packageRoot := t.TempDir()
	sourceBackend := filepath.Join(packageRoot, "src", "ipc-backend.ts")
	executablePath := filepath.Join(packageRoot, "tui", "vetala")

	writeTestFile(t, sourceBackend)

	command, err := resolveBackendCommand(executablePath, "/tmp/workspace")
	if err != nil {
		t.Fatalf("resolveBackendCommand returned error: %v", err)
	}

	if command.Dir != packageRoot {
		t.Fatalf("expected command dir %q, got %q", packageRoot, command.Dir)
	}

	if command.File != "npx" {
		t.Fatalf("expected command file %q, got %q", "npx", command.File)
	}

	expectedArgs := []string{"tsx", sourceBackend, "--workspace", "/tmp/workspace"}
	if !reflect.DeepEqual(command.Args, expectedArgs) {
		t.Fatalf("expected args %v, got %v", expectedArgs, command.Args)
	}
}

func TestResolveBackendCommandFailsWhenBackendMissing(t *testing.T) {
	packageRoot := t.TempDir()
	executablePath := filepath.Join(packageRoot, "tui", "vetala")

	_, err := resolveBackendCommand(executablePath, "/tmp/workspace")
	if err == nil {
		t.Fatal("expected resolveBackendCommand to fail when no backend exists")
	}
}

func writeTestFile(t *testing.T, target string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("creating parent directory for %q: %v", target, err)
	}

	if err := os.WriteFile(target, []byte("test"), 0o644); err != nil {
		t.Fatalf("writing %q: %v", target, err)
	}
}
