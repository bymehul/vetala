# Vetala

Vetala is a terminal-first coding assistant with an interactive TUI, local tools, approval gates, session memory, and a skill system for reusable workflows.

This is the first build and not a stable v1 release, so some bugs are expected.

![Vetala terminal UI](./terminal.png)

## Overview

Vetala is designed for code-focused terminal work:

- interactive CLI built with Go and Bubble Tea
- multi-turn sessions with persisted state
- local file, shell, git, and web-capable tool execution
- approval-aware operations for safer workspace access
- local `skill/` runtime for reusable instructions and references
- prompt compaction to preserve continuity across longer sessions
- provider-aware model selection with Sarvam and OpenRouter profiles
- provider-first `/model` flow with OpenRouter model-id entry
- diff previews for file edits and `/undo` for the last tracked change
- queued or force-sent follow-up prompts while the current turn is still running
- startup update notifier powered by `update-notifier` with “update now” or “update later”
- built-in HTML search providers with DuckDuckGo by default and Stack Overflow for coding lookups

Current provider support includes Sarvam AI and OpenRouter.

## Patch Notes

### v0.3.3-dev

- **Cross-Platform TUI Packaging**: npm packages now bundle prebuilt TUI binaries for `linux`, `darwin`, and `win32` on `x64` and `arm64`, with the CLI selecting the matching binary at runtime.
- **Installed Backend Launcher Fix**: The bundled Go TUI now resolves the package root correctly and starts the compiled backend from `dist/src/ipc-backend.js` in published installs.
- **Dev Fallback Retained**: Source checkouts still fall back to `npx tsx src/ipc-backend.ts` when the compiled backend is unavailable.
- **Release Guardrails**: Added Go-side launcher tests, release-time cross-build coverage, and installed-package smoke checks so packaged installs keep working.

### v0.3.2-dev

- **Bundled TUI Packaging Fix**: Published installs now include the `tui/vetala` binary required by the global `vetala` launcher.
- **Clearer Startup Failure**: The CLI now reports an explicit install error when the bundled TUI binary is missing instead of crashing with an unhandled `ENOENT`.
- **Packaging Regression Coverage**: Added a regression test to keep the packaged file list and app version metadata in sync.

### v0.3.1-dev

- **Improved Search Matching**: Fixed a bug in `search_repo` glob matching to correctly handle nested directory patterns and absolute paths.
- **Reliable Fallback Search**: Disabled PTY for `ripgrep` to ensure reliable fallback to manual search when the binary is missing.
- **Update Notifications**: Integrated `update-notifier` for better version awareness.

### v0.3.0-dev

- **Total UI Re-architecture**: Switched from React Ink to a high-performance Go + Bubble Tea TUI.
- **Improved Tool Formatting**: Redesigned tool executions to extract and highlight key parameters (e.g., `file_path`, `command`), avoiding large raw JSON blobs.
- **IPC Backend**: Node.js agent now runs in headless mode, commanded purely via IPC from the Go frontend.
- **Improved Terminal Emulation**: Switched to `node-pty` for more robust shell tool execution.


## Compatibility

Vetala is currently tested on Linux.

Published npm installs bundle prebuilt TUI binaries for Linux, macOS, and Windows on `x64` and `arm64`, but macOS and Windows should still be treated as early-support targets until they receive broader validation.

## Installation

### Global install

```bash
npm install -g @vetala/vetala
vetala
```

The published npm package bundles the TUI binary for supported targets, so end users do not need Go for a normal install.

### Local development install

```bash
npm install
npm run build:tui
npm link
vetala
```

`npm run build:tui` is only needed for source checkouts and requires Go.

The package is published as `@vetala/vetala` and exposes a global `vetala` binary through `package.json`.

## Getting Started

Run Vetala in a project directory:

```bash
vetala
```

Or run from source during development:

```bash
npm run dev
```

On startup, Vetala opens an interactive terminal UI and asks you to confirm trust for the current workspace before enabling tool access.
It also detects the current host platform, shell, and terminal profile and exposes that context in the UI and agent runtime.

## Configuration

Model selection and credential setup are available from inside the TUI through:

```text
/model
```

The default web search provider is DuckDuckGo HTML. For programming-specific web lookups, Vetala also exposes `stack_overflow_search`.

Configuration and session data are stored in the user application directory for the current platform.
`/config` also prints the `host:` and `term:` lines used in issue reports.

## Core Commands

- `/help` shows available commands
- `/model` updates model and auth settings
- `/skill` lists and manages local skills
- `/tools` shows available tools
- `/history` shows recent session messages
- `/resume <session-id>` reopens a saved session
- `/new` starts a fresh session
- `/undo` reverts the last tracked file edit in the current session
- `/approve` shows active approvals
- `/config` prints runtime configuration
- `/logout` clears locally saved auth state
- `/clear` clears the visible transcript
- `/exit` exits the application

## Skills

Vetala loads local skills from:

```text
skill/<name>/SKILL.md
```

Skills are indexed locally and exposed through the `skill` tool so the assistant can:

- list available skills
- load a skill overview
- read referenced files inside a skill
- pin and unpin skills across turns

This keeps the default prompt smaller while still allowing deeper workflow guidance when needed.

## Development

```bash
npm run check
npm test
npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Licensed under Apache-2.0. See [LICENSE](./LICENSE).

Modified third-party material is documented in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
