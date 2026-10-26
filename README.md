# FlowDeck

A Linux desktop canvas for running many coding-agent sessions side by side — **Claude Code**,
**OpenAI Codex**, **Kiro** and plain shells — each node bound to an account, with live status,
per-account usage, agent-to-agent messaging over edges you draw, and full restoration after a
reboot. Everything is local: no telemetry, no outbound requests, no
credentials read.

```
┌──────────── FlowDeck (Electron) ────────────┐
│ renderer: React Flow canvas + xterm.js      │      tmux -L flowdeck  (outlives the app)
│      │ typed IPC (preload, sandboxed)       │      ┌──────────────────────────────┐
│ main: Core ── tmux ──────────────────────────────▶ │ fd-xxxx: claude --session-id … │
│        │      node-pty (tmux attach) ◀──────────── │ fd-yyyy: claude --resume …     │
│        │                                    │      └──────┬───────────────┬───────┘
│        └─ Unix socket 0600 ◀── hook.sh ◀────────── hooks ─┘               │ stdio
│              (hooks + agent API) ◀── flowdeck-mcp ◀───────────────────────┘
│        SQLite: layout, nodes, edges, log    │
└─────────────────────────────────────────────┘
```

## Requirements

- Linux x64 (Ubuntu/Debian), `tmux` ≥ 3.3, `bash`, `curl`
- At least one agent CLI in your `PATH`: `claude`, `codex` and/or `kiro-cli` (missing ones are
  greyed out in the New node dialog)
- For development: Node 22+, pnpm 10 (`corepack enable pnpm`), a C/C++ toolchain

## Install

```bash
sudo apt install tmux curl
cp packages/app/release/flowdeck-0.3.0-amd64.deb /tmp/   # apt reads it as an unprivileged user
sudo apt install /tmp/flowdeck-0.3.0-amd64.deb             # sets up Chromium's sandbox + AppArmor profile
```

**macOS (experimental, unsigned, untested on real hardware):** a `.dmg` is built for Apple Silicon
and Intel. Install `tmux` with Homebrew, open the app with right-click → Open the first time.
Claude Code keeps its login in the macOS Keychain, so Claude accounts may show as logged out.

The AppImage also works, but on Ubuntu 24.04+ Electron AppImages need an AppArmor profile for
unprivileged user namespaces; prefer the `.deb`. FlowDeck never runs with `--no-sandbox`.

## Accounts

An account is a config directory: `~/.claude` / `~/.claude-<name>` for Claude Code and
`~/.codex` / `~/.codex-<name>` for Codex. Create one with `mkdir ~/.claude-work` (or
`~/.codex-work`), register it in **Accounts**, then **Open login node** and log in inside it.
FlowDeck only checks whether the credential file exists; it never reads it. Kiro uses its single
system login (`kiro-cli login`).

## Usage

- **+ New node** (`Ctrl+Shift+N`) creates a Claude Code, Codex, Kiro or Shell node in a
  directory. The dialog remembers your last choices and **How many** creates up to 6 at once.
  **Duplicate** (`Ctrl+Shift+D`, the ⧉ button or the Terminals panel) clones a node into a new
  session next to it.
- Drag by the header, resize when selected, double-click the header to zoom to 100 %.
  Rename with ✎ in the header or in the Terminals panel (or double-click the title).
- **Terminal text** (Ubuntu conventions): selecting with the mouse copies (PRIMARY and clipboard);
  **middle click** pastes the selection, **Ctrl+Shift+V** pastes the clipboard, **Ctrl+Shift+C**
  copies. Selection is exact at any canvas zoom.
- **Scrollback**: the mouse wheel scrolls back with a slim scrollbar you can drag; just start
  typing to return to the prompt.
- **Groups and texts** on the canvas: **▭ Group** (`Ctrl+Shift+G`) wraps the selected terminals,
  or drag a rectangle; **T Text** (`Ctrl+Shift+X`) adds a caption. Dragging a group by its title
  moves everything inside it. Select one to change colour, text size or delete it (also with
  Delete); deleting a group never closes terminals.
- **Terminals** panel: every terminal with a coloured bullet, attention first, live counts, a
  legend, and Go to / Duplicate / Resume / Close actions. The tab shows how many need you.
- Colours: blue pulsing = working, green = idle/finished, orange = needs you, purple = starting,
  grey = stopped, red ring = the node runs without approval prompts.
- **Codex**: the first launch per Codex account asks you to review FlowDeck's hooks — choose
  "Trust all and continue" (or `/hooks` → `t`) once; until then the node stays "Starting".
- **Kiro**: status comes from terminal activity (no "needs you"); Kiro can receive messages but
  cannot send them yet.
- Desktop notifications fire on "finished" and "needs input" while FlowDeck is not focused.
- Drag from a node's right handle to another node's left handle to connect them (two-way or one-way,
  chosen in the toolbar). Connected Claude Code and Codex agents get the `flowdeck` MCP tools `list_peers`, `send_to` and
  `read_inbox`. Messages are typed into the receiver only when it is idle and not focused, prefixed
  with `[from: <title>]`; otherwise they wait for its next `Stop`. Every message is in **Messages**.
- Closing FlowDeck never stops your sessions. After a reboot, opening FlowDeck recreates each node in
  the same place, on the same account, resuming the same conversation.
- **Start at login** writes `~/.config/autostart/flowdeck.desktop`.

## Development

```bash
corepack enable pnpm
pnpm install          # also rebuilds native modules for Electron
pnpm dev              # run the app
pnpm typecheck
pnpm test             # unit + integration (real tmux, fake claude)
pnpm e2e              # Playwright against the built app
pnpm build            # AppImage + .deb
```

Docs: [`docs/spec.md`](docs/spec.md) (spec), [`docs/DESIGN-REVIEW.md`](docs/DESIGN-REVIEW.md)
(architecture review and changes), [`docs/PLAN.md`](docs/PLAN.md) (execution plan),
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) (test and security results),
[`docs/MANUAL-CHECKS.md`](docs/MANUAL-CHECKS.md) (what still needs a human).
