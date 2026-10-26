# Execution Plan

Implementation plan for the FlowDeck MVP, following the seven phases of `docs/spec.md` with the
changes from `docs/DESIGN-REVIEW.md`. Each phase ends with tests passing.

## Toolchain

| Item | Version |
|---|---|
| Node | 24.x (dev), Electron's bundled Node at runtime |
| pnpm | 10.x workspaces, `node-linker=hoisted` (required by electron-builder) |
| Electron | 44.x, electron-vite 6, Vite 8 |
| UI | React 19, Zustand 5, @xyflow/react 12, @xterm/xterm 6 |
| Native | node-pty, better-sqlite3 (rebuilt for Electron with @electron/rebuild) |
| Agents | @modelcontextprotocol/sdk (stdio), zod |
| Tests | Vitest (unit + integration), Playwright `_electron` (E2E) |
| System | tmux ≥ 3.3, bash, curl |

## Packages

```
packages/shared   types and contracts: node/account/edge/message, states, hook events, IPC channels
packages/mcp      flowdeck-mcp stdio server (list_peers, send_to, read_inbox)
packages/app      Electron app: main / preload / renderer, resources (hook.sh, tmux.conf)
```

## Phases

| Phase | Deliverables | Automated verification |
|---|---|---|
| 1. Foundation | Monorepo, Electron + React + React Flow, SQLite schema + migrations, typed IPC, secure window | Unit: migrations, repositories. E2E: create node, drag, restart, same position |
| 2. Persistent terminals | `main/tmux` (argv builder, generated tmux.conf, sanitised env), `main/pty` bridge with batching, xterm node | Integration: real tmux on a test socket (create, has-session, capture, kill). E2E: shell node survives app restart |
| 3. Accounts | Discovery of `~/.claude*` dirs, logged-in check (existence only), account panel, colour badge per node | Unit: discovery in a temp HOME, default-dir env rule (H3) |
| 4. Status & notifications | `hook.sh`, `--settings` file, Unix socket server (0600, token, size limit), state machine, borders, notifications | Unit: state machine, payload parsing. Integration: real `hook.sh` → real socket; permissions; spoofing rejected |
| 5. Restore | `--session-id`, restore loop (`has-session` → attach or recreate with `--resume`), optional autostart `.desktop` | Unit: restore decisions. E2E: kill tmux server (simulated reboot), reopen, node recreated with `--resume <id>` (fake `claude`) |
| 6. Usage | Incremental JSONL reader, dedupe, 5 h block + 7 d window, per-account cap, panel | Unit: fixtures (duplicates, malformed lines, block boundaries, truncation) |
| 7. Agents talking | Edges with rules, `flowdeck-mcp`, queue + delivery on `Stop`, rate limit, message log | Unit: bus rules. Integration: MCP client ↔ `flowdeck-mcp` ↔ socket. E2E: leader → busy reviewer, delivered only after `Stop` |

## Test strategy

- **Fake Claude** (`packages/app/tests/fixtures/fake-claude.sh`): a bash stand-in that reads the
  hook commands FlowDeck passes in `--settings`, fires `SessionStart`, then `UserPromptSubmit`/`Stop`
  around each line typed into it. This exercises the real tmux, hook script, socket, state machine
  and delivery path end to end without spending tokens. Selected with `FLOWDECK_CLAUDE_BIN`.
- **Isolation**: tests run with temporary `HOME`, `XDG_RUNTIME_DIR`, data dir and a unique tmux
  socket name (`FLOWDECK_TMUX_SOCKET`), so they never touch the user's sessions.
- **Real Claude smoke check**: start one real `claude` node and confirm the `SessionStart` hook
  arrives through `--settings` (no prompt is sent, so no tokens are used).
- **Security**: Snyk Code + Snyk Open Source scans, `pnpm audit`, plus dedicated tests for socket
  permissions, token rejection, oversized bodies, edge rules, sanitisation and Electron
  `webPreferences`.

## MVP acceptance mapping

| Criterion | Where it is verified |
|---|---|
| 1. 6 sessions, 2 accounts, one canvas | E2E creates 6 nodes across 2 accounts |
| 2. Status at a glance + notifications | State machine tests + E2E border state after hook events |
| 3. Account + 5 h / 7 d usage on each node | Usage fixture tests + badge rendered in E2E |
| 4. Connect two nodes, send a task, logged | MCP integration test + E2E delivery |
| 5. Reboot restore | E2E with tmux server killed between runs |

Items that need a human (real reboot, real `/status` e-mail per account, real notifications on
the desktop) are listed in `docs/MANUAL-CHECKS.md`.
