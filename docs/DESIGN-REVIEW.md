# Design & Architecture Review

Review of the MVP specification (`docs/spec.md`, originally "Regente") before implementation.
The project is built under the name **FlowDeck** (repository name), which resolves the spec's
open question about the final name. Every `regente` identifier in the spec maps to `flowdeck`
(tmux socket `-L flowdeck`, env vars `FLOWDECK_*`, data dir `~/.local/share/flowdeck`).

Verdict: **the architecture is sound** — tmux as the process owner, Claude Code hooks as the
status source, a Unix-socket event server and a stdio MCP bridge are the right primitives.
The review found 4 high-impact issues and a dozen refinements, all adopted below.

## High-impact changes

### H1. Do not mutate the user's `settings.json` — inject per launch
The spec backs up and edits `<config_dir>/settings.json` and runs `claude mcp add -s user`.
That is the riskiest part of the design (conflicts with user hooks, needs a diff/approval UI,
an uninstall path, and leaves state behind if the app is removed).

Claude Code (verified on 2.1.309) supports `--settings <file>` and `--mcp-config <file>`, which
are **merged** with the user's own settings and MCP servers. FlowDeck therefore launches every
Claude node as:

```
claude --session-id <uuid> --settings <data>/claude-settings.json --mcp-config <data>/nodes/<id>/mcp.json
```

Result: zero writes to any account directory, nothing to back up or uninstall, no diff UI, and
the "hooks conflict with yours" risk disappears. Hooks are still guarded by
`FLOWDECK_NODE_ID`, so they are inert if the file is ever loaded elsewhere.

### H2. Assign the Claude session id up front (`--session-id`)
The spec relies on the `SessionStart` hook to learn the session id, and falls back to
`claude --continue` when it is missing. `--continue` picks *the most recent conversation in the
cwd*, which is the wrong conversation whenever two nodes share a directory (criterion 5).

FlowDeck generates a UUID per node and passes `--session-id` on first launch, so the id is
known before Claude even starts. `SessionStart` still updates it (it changes on `/clear`).
On restore: `--resume <id>`; `--continue` is only used for legacy rows without an id **and**
when no other node shares the same cwd + account; otherwise a fresh session starts.

### H3. The default `~/.claude` account must not set `CLAUDE_CONFIG_DIR`
With `CLAUDE_CONFIG_DIR` unset, Claude Code uses `~/.claude/` **and** `~/.claude.json`.
With `CLAUDE_CONFIG_DIR=~/.claude` it looks for `~/.claude/.claude.json` instead, so the user
would lose onboarding state, trusted folders and MCP config. FlowDeck leaves the variable
unset for the default directory and sets it only for `~/.claude-*` accounts.

### H4. Sanitise the tmux server environment
The tmux server inherits the environment of the process that starts it, and every node inherits
the server's. If the app is launched from a shell with `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`
or `CLAUDECODE` set, every node would silently use that key/account instead of the one shown
on its badge. FlowDeck starts tmux with these variables stripped (by name; values are never
read), so the badge is always the truth.

## Refinements

| # | Area | Spec | Change | Why |
|---|------|------|--------|-----|
| R1 | tmux | default keys | `prefix None`, mouse on, `escape-time 0`, `window-size latest` | `Ctrl+B` belongs to Claude Code (background tasks); the user never needs tmux keys inside a node |
| R2 | tmux | `... claude` as a shell string | Command passed as separate argv elements (tmux ≥ 3.0 execs directly) | No shell parsing of cwd, titles or launch args → no injection |
| R3 | Status | `Notification` → `needs_input` | Use `notification_type`: `idle_prompt` keeps `idle`; others → `needs_input`. Add `PostToolUse` → `working` | The 60 s idle reminder is not a request for action; after a permission is granted only `PostToolUse` signals work resumed |
| R4 | Status | — | `PostToolUse` hook sends no body | Tool outputs never leave Claude's process; less I/O per tool call |
| R5 | Delivery | `send-keys -l` + Enter | `load-buffer` + `paste-buffer -p` (bracketed paste) + Enter; control characters stripped | Multi-line messages would be submitted line by line; escape sequences could drive the terminal |
| R6 | Bus | 4,000-char limit | + rate limit (per edge, per minute) and per-target queue cap | Two connected agents can ping-pong forever and burn quota |
| R7 | Bus | `read_inbox` vs typed delivery | One message is delivered exactly once, either typed (`pty`) or read (`inbox`) | Avoids a message being both typed and returned by the tool |
| R8 | Identity | `REGENTE_NODE_ID` only | + per-node random token checked by the socket server; sent in a header file descriptor, never in argv | Stops trivial impersonation of another node (see residual risk below) |
| R9 | Usage | sum all JSONL lines | Dedupe by `message.id` + `requestId`; 5 h window = active session block (ccusage semantics); incremental reads by byte offset; only files touched in the last 7 days | Streaming writes duplicate lines (≫5 % error); full re-reads every 30 s do not scale |
| R10 | Terminal | xterm.js + WebGL addon | DOM renderer | Chromium caps WebGL contexts (~16); DOM text stays crisp when the canvas is zoomed |
| R11 | Canvas | — | Drag only by node header; terminal area is `nodrag nowheel`; "zoom to 100 %" action | Text selection and scrolling inside terminals must not move the canvas |
| R12 | Packaging | `regente-mcp` binary | MCP server bundled to one file and run with the app's own binary (`ELECTRON_RUN_AS_NODE=1`), `$APPIMAGE` path when packaged | No system Node dependency; AppImage mount paths change on every run |
| R13 | Events | — | Body limit 256 KiB, JSON schema validation, unknown events ignored, status falls back to `unknown` | Hook formats are external contracts that may change |
| R14 | Electron | contextIsolation, no nodeIntegration, CSP | + `sandbox: true`, IPC sender validation, navigation/window-open/permission requests denied, all non-local requests blocked in the session | Enforces "no outbound network" at the renderer level |

## Residual risks (accepted for the MVP)

- **Same-user isolation is not a security boundary.** Any process running as the user can read
  `/proc/<pid>/environ` of another node and obtain its token. Tokens stop accidental or naive
  impersonation, not a determined local process. The real control is the edge model plus the
  dangerous-mode rule, both enforced in the main process at send time.
- **Agents with Bash can reach tmux.** Inside a node, `$TMUX` reveals the dedicated socket, so an
  agent allowed to run shell commands can `tmux send-keys` into any node, and it can read other
  nodes' tokens (`nodes/<id>/mcp.json`, `/proc/<pid>/environ`). Edge enforcement therefore holds only
  while Bash stays permission-gated in the sending node, which is another reason skip-permission
  nodes can never receive from normal ones.
- **Interrupted turns.** Claude Code does not fire `Stop` when the user presses `Esc`; the node
  stays `working` until Claude's idle reminder (`idle_prompt`, about 60 s later) returns it to `idle`.
- **Zoomed terminals.** xterm.js mouse selection is offset when the canvas scale ≠ 1.
  Mitigated with the "zoom to 100 %" action.
- **Usage caps.** Plan limits are not public; percentages use a cap configured per account.
- **Internal formats.** JSONL and hook payloads are parsed only in `main/usage` and
  `main/events`, each with fixture tests.

## Security model summary

| Asset / threat | Control |
|---|---|
| Credentials | Never opened. Only `fs.existsSync(<dir>/.credentials.json)` for the "logged in" badge |
| Network | No outbound requests; renderer requests to non-`file:` / non-dev-server URLs are cancelled |
| Event socket | `$XDG_RUNTIME_DIR/flowdeck.sock`, mode 0600, directory 0700, no TCP port |
| Hook spoofing | Per-node token, constant-time compare, unknown node → 404 |
| Agent → agent injection | Edge required; one-way edges respected; dangerous-mode rule; 4,000-char limit; rate limit; sender prefix; full audit log |
| Terminal injection | Control characters stripped before typing; bracketed paste |
| Command injection | All child processes via `execFile`/argv, never a shell string; ids validated as UUIDs; cwd validated as an existing absolute directory |
| Renderer compromise | Sandbox, contextIsolation, CSP, typed and validated IPC, no Node access |

## Findings during implementation

| # | Finding | Resolution |
|---|---|---|
| I1 | **Descriptor leak into tmux.** The tmux server is forked from Electron and inherited ~90 Chromium descriptors without `CLOEXEC` (profile locks, GPU caches, IPC sockets). The server outlives the app, so it kept FlowDeck's profile locked and held test-runner pipes open. | `new-session` (the only command that can start the server) runs through a tiny shell that closes every fd > 2 before `exec tmux`. Covered by a unit test and an E2E assertion on `/proc/<tmux pid>/fd`. |
| I2 | `--resume <id>` fails for a node that never received a prompt (Claude Code writes no transcript until then). | Restore checks whether `<config>/projects/*/<id>.jsonl` exists (by name only) and otherwise relaunches with the same `--session-id`. |
| I3 | Hooks fired while FlowDeck is closed were lost, so a node that finished or asked for permission meanwhile showed a stale state. | `hook.sh` spools the last event name to `<data>/spool/<node>` when the socket is unavailable; the app applies it on start. |
| I4 | `flowdeck-mcp` runs with the app binary and `ELECTRON_RUN_AS_NODE=1`, so the `RunAsNode` Electron fuse must stay enabled. | Accepted: it avoids depending on a system Node. Any local process can already run code as the user, so the fuse adds no new capability. |
| I5 | Ubuntu 24.04 restricts unprivileged user namespaces; Electron's sandbox then needs the setuid `chrome-sandbox` or an AppArmor profile. | The `.deb` installs both (electron-builder default). The app is never run with `--no-sandbox`. |
| I6 | Verified against Claude Code 2.1.309: hooks from `--settings` fire (SessionStart received with the FlowDeck-assigned `--session-id`) and `--mcp-config` loads `flowdeck` with 3 tools. | Kept as an opt-in smoke test (`FLOWDECK_REAL_CLAUDE=1`). |

## Independent review (fixed)

A separate read-only review of the code found these; each now has a regression test.

| # | Issue | Fix |
|---|---|---|
| V1 | Pane-liveness check used an async snapshot, so a node created or restarted meanwhile was marked "dead" (also found by an E2E screenshot run) | Skip nodes being launched or changed after the snapshot; confirm a missing session with `has-session`; a tmux error never marks nodes dead |
| V2 | Two deliveries in the same millisecond shared a tmux buffer name, so text could land in the wrong node | Random buffer names and one serialised paste queue |
| V3 | A body could forge a second `[from: …]` header with newlines, and hide text with invisible format characters | Messages are folded to one line (`⏎`), `[from:` inside a body becomes `(from:`, `\p{Cf}` characters are removed. A single line also means a pasted line can never start with `!` (Claude Code's bash mode) |
| V4 | Only the literal `--dangerously-skip-permissions` counted as dangerous | Also `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions` and `defaultMode: bypassPermissions` in managed, account or project settings (read-only) |
| V5 | Cutting an edge or deleting the sender did not stop already-queued messages | Route and escalation rule are re-checked for every message at delivery; revoked ones are discarded and logged |
| V6 | `SessionStart` delivered queued messages, possibly into a startup dialog or mid-turn (`compact`) | No delivery on `SessionStart`; `compact` keeps the state; queues drain on `Stop` or the idle reminder |
| V7 | User arguments after the variadic `--mcp-config`, and `-r<id>`-style short flags | FlowDeck flags come first; reserved short flags are detected inside combined/inline forms |
| V8 | Queues not drained after restore; unbounded notifications from hook spam; dev-server URL matched by prefix | Drain after restore; one notification per node per 3 s; origin comparison |
