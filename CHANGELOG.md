# Changelog

## 0.3.0

- **Exact mouse selection** in terminals at any canvas zoom (the pointer used to pick a line above
  or below when the canvas was not at 100 %).
- **Linux clipboard**: selecting text copies it (PRIMARY and clipboard); middle click pastes the
  selection; Ctrl+Shift+V pastes the clipboard; Ctrl+Shift+C copies. Programs inside a node cannot
  set the clipboard, and pastes cannot break out of bracketed paste.
- **Scrollback**: a slim, draggable scrollbar replaces tmux's yellow position indicator; typing
  after scrolling back goes straight to the program.
- **Rename** terminals from the node header (✎) or the Terminals panel.
- **Groups and texts on the canvas**: transparent coloured groups (Ctrl+Shift+G wraps the
  selected terminals, or draw one) that move everything inside them, and free-text captions
  (Ctrl+Shift+X) with colours and sizes. Saved with the layout.
- The **Fit** button works again.
- **macOS (experimental)**: unsigned `.dmg` for Apple Silicon and Intel.

Install on Ubuntu/Debian: `sudo apt install ./flowdeck-0.3.0-amd64.deb` (copy it to `/tmp` first
if it sits in your home directory). On macOS: `brew install tmux`, then open the app with
right-click → Open the first time.

## 0.2.0

- Codex and Kiro nodes next to Claude Code and Shell.
- Terminals panel with live coloured status, counts and legend.
- New node dialog with all types, remembered choices and "How many"; Duplicate (Ctrl+Shift+D).
- Node tokens only in a private identity file, rotated on every launch.

## 0.1.0

- Canvas of Claude Code sessions on several accounts, status from hooks, per-account usage,
  agent-to-agent messages over edges, restoration after a reboot.
