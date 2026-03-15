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

### v0.5.3
Added:
- Viewport-backed transcript with in-app scrollback (PgUp/PgDn + mouse wheel).
- Global tool details toggle (Ctrl+T) and env-tunable UI/search limits.

Patched:
- Buffered output while modals are open to prevent UI jumps.
- Streaming now sends a final assistant entry; live preview is capped to avoid duplication.
- Fast search skips binaries/oversized files and handles long lines safely.

### v0.5.2
Added:
- `/resume` now skips empty sessions and previews the last few messages when resuming.
- Workspace auto-resume uses the most recent non-empty session.

Patched:
- Resume selection list starts at the top and scrolls cleanly for longer lists.
- Modal transitions no longer leave duplicate empty boxes.

### v0.5.1
Added:
- New data layout: `memories/`, `rules/`, `snapshots/`, `logs/`, `tasks/`, and `history.jsonl`.
- Background memory pipeline that writes `raw_memories.md`, rollout summaries, and a consolidated `MEMORY.md`.
- Configurable memory/context/history limits (visible in `/config`).
- Update notifier inside the TUI flow with “update now” or “skip for 24 hours”.

Patched:
- Update checks now run before the TUI trust prompt (and won’t duplicate when launched from the CLI).
- History persistence trims safely to the configured size cap.

### v0.5.0
- **bugfix**: major bug fixes and performance improvements
- **Universal Syntax Diagnostics**: Replaced the Python-only `compileall` fallback in `get_diagnostics` with `web-tree-sitter`. Vetala can now perform syntax checking across multiple languages (TypeScript, Python, Go, Rust, C, C++, Java, Ruby) directly in memory, even if you don't have the native compiler installed on your machine!
- **Data-Driven Language Registry**: Centralized language management and file extension mapping. Adding new language support is now a single object definition.
- **Smart Two-Tier Checks**: Diagnostics now try native tools first (`npx tsc`, `go build`) for the highest quality errors, and transparently fall back to WASM tree-sitter parsing if the toolchain is missing.


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
