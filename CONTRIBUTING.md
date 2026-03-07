# Contributing

Thank you for contributing to Vetala.

## Development Setup

Requirements:

- Node.js 24 or newer
- npm

Install dependencies:

```bash
npm install
```

Run Vetala locally:

```bash
npm run dev
```

Optional local CLI install:

```bash
npm link
vetala
```

## Validation

Run these before opening a pull request:

```bash
npm run check
npm test
npm run build
```

## Project Notes

- The interactive terminal UI is built with Ink.
- Local skills live under `skill/<name>/SKILL.md`.
- The agent is expected to prefer search-first, scoped-read workflows before edits.
- Existing files should not be edited unless they have been read first through the tool layer.
- Linux is the validated platform today. Windows and macOS support should be treated as unverified until tested.

## Change Guidelines

- Keep changes focused and reviewable.
- Preserve the existing CLI interaction model unless the change intentionally revises it.
- Add or update tests when changing tool behavior, session persistence, approvals, prompts, or UI flows.
- Include screenshots when changing TUI layout or interaction behavior.
- Document any new commands, environment variables, or config behavior.

## Pull Requests

A good pull request should include:

- a short explanation of the problem being solved
- a summary of the behavior change
- any platform assumptions or gaps
- screenshots for visible UI changes when relevant
- notes on new risks, migrations, or follow-up work

## Issues

Use the issue templates when possible.

Good bug reports include:

- the command or prompt that triggered the issue
- what you expected
- what happened instead
- logs, stack traces, or screenshots
- OS, Node version, installation method, and configuration context
