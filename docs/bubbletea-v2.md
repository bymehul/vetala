# Bubble Tea v2 (Quick Reference)

Source: pkg.go.dev/charm.land/bubbletea/v2

## Model Interface
- `Init() Cmd`
- `Update(Msg) (Model, Cmd)`
- `View() View`

## View
- `View` is a struct; build it with `tea.NewView(<string>)`.
- Use `View.MouseMode` (e.g., `MouseModeCellMotion`) to receive mouse events.
- Optional fields include `AltScreen`, `Title`, and `Cursor`.

## Messages
- Keyboard input arrives as `KeyPressMsg` and `KeyReleaseMsg`.
- Use `msg.String()` (or `msg.Key().String()`) for keystroke comparisons.
- Mouse input arrives via `MouseMsg` variants when `MouseMode` is enabled.

## Commands
- `Cmd` is a `func() Msg`.
- Use `tea.Batch(...)` to combine commands.

## Program
- `tea.NewProgram(model, opts...)` starts the TUI.
- `Run()` executes the program and returns the final model.

## Notes for Vetala
- Prefer per-component layout and padding; avoid global frame math.
- Enable mouse mode if viewport wheel scrolling is desired.
