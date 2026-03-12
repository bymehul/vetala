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

### v0.4.1-dev

- **Sequential Interactive Prompts**: Upgraded the `ask_user` tool to support arrays of questions (both text and multiple-choice), asking the user sequentially instead of dumping them all into one prompt.
- **Smart API Retry Loop**: Vetala now automatically intercepts provider API errors (like unexpected token limits or `fetch failed` drops) without crashing. It injects an automatic prompt hint back to the AI so the AI can correct itself and retry!
- **Broader Approval Contexts**: The "Allow for session" option is now vastly smarter. Approving a file write now auto-approves all file writes (`edit_file:*`) for the session, and approving an NPM install auto-approves all subsequent dependency installs (`run_shell:pkg_install`), minimizing prompt fatigue.
- **Interactive Update Notifier**: Replaced the default `update-notifier` with a custom startup prompt. It pauses the TUI launch if an update is found, allowing you to install it instantly or snooze it.
- **Note on Vision Tools**: The `analyze_image` tool remains in the CLI but true vision testing is ongoing. Text-only models are still gracefully warned to avoid hallucinations.

### v0.4.0-dev

- **Advanced Cross-Platform Tools**: Added 6 new semantic and interactive tools (`ask_user`, `analyze_image`, `read_docs`, `get_diagnostics`, `list_exports`, `find_references`, `ast_replace`, `semantic_search`).
- **Interactive Model Refinement**: `Ctrl+C` while the agent is running no longer crashes the CLI. It gracefully pauses the agent, sends an interrupt to the backend, and opens a prompt asking how you would like to refine the agent's course.
- **Enhanced File System Tooling**: Added `append_to_file`, `move_file`, and `delete_file` tools to give models finer-grained local workspace control and bypass JSON limits for large file rewrites.
- **Markdown TUI Rendering**: Agent messages are now beautifully rendered in the TUI using `glamour`.
- **Note on Vision Tools**: The `analyze_image` tool gracefully warns text-only models to avoid hallucination, but true vision testing is ongoing.

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
