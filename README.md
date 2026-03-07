# Vetala

Vetala is a terminal-first coding assistant with an interactive TUI, local tools, approval gates, session memory, and a skill system for reusable workflows.

This is the first build and not a stable v1 release, so some bugs are expected.

![Vetala terminal UI](./terminal.png)

## Overview

Vetala is designed for code-focused terminal work:

- interactive CLI built with Ink
- multi-turn sessions with persisted state
- local file, shell, git, and web-capable tool execution
- approval-aware operations for safer workspace access
- local `skill/` runtime for reusable instructions and references
- prompt compaction to preserve continuity across longer sessions

Current provider support is limited to Sarvam AI.

## Compatibility

Vetala is currently tested on Linux.

Windows and macOS have not been validated yet.

## Installation

### Global install

```bash
npm install -g @vetala/vetala
vetala
```

### Local development install

```bash
npm install
npm link
vetala
```

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

## Configuration

Model selection and credential setup are available from inside the TUI through:

```text
/model
```

Configuration and session data are stored in the user application directory for the current platform.

## Core Commands

- `/help` shows available commands
- `/model` updates model and auth settings
- `/skill` lists and manages local skills
- `/tools` shows available tools
- `/history` shows recent session messages
- `/resume <session-id>` reopens a saved session
- `/new` starts a fresh session
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
