# Verification Report

State of FlowDeck 0.1.0 on 2026-10-23 (Ubuntu 24.04, Node 24, Electron 44.9.3, tmux 3.4,
Claude Code 2.1.309).

## Automated tests — all passing

| Suite | Command | Result |
|---|---|---|
| Shared schemas | `pnpm test` | 5 / 5 |
| `flowdeck-mcp` over real stdio (MCP SDK client ↔ bundled server ↔ socket) | `pnpm test` | 4 / 4 |
| App unit (state machine, rules, sanitisation, usage, DB, socket server, launch, hardening) | `pnpm test` | 65 / 65 |
| App integration (real tmux + real `hook.sh` + Unix socket + fake `claude`) | `pnpm test` | 19 / 19 |
| E2E, Playwright driving the built Electron app | `pnpm e2e` | 5 / 5 |
| Real Claude Code smoke (no prompt, no tokens) | `FLOWDECK_REAL_CLAUDE=1 …` | 1 / 1 |
| Type check, strict, all packages | `pnpm typecheck` | clean |

### MVP criteria

| Criterion | Evidence |
|---|---|
| 1. 6 sessions, 2 accounts, one canvas | Integration and E2E start 6 Claude nodes on 2 accounts; all reach `idle` through real hooks; the default account runs without `CLAUDE_CONFIG_DIR`, the other with its own; a parent `ANTHROPIC_API_KEY` never reaches a node |
| 2. Status at a glance + notifications | `working` → `idle` with a "finished" notification; a permission request → `needs_input` (orange, with the text) → approval → `working` → `idle`; border/minimap colours checked in the UI |
| 3. Account and 5 h / 7 d usage on each node | Badges show the account per node; usage computed from transcripts (dedup, 5 h block, 7 d window) |
| 4. Connect, send, log | Leader → busy reviewer is `queued`, typed only after the reviewer's `Stop`, logged as delivered; shown in the Messages panel |
| 5. Reboot restore | tmux server killed (what a reboot does) → reopen → same layout and accounts; nodes with a conversation `--resume` it, others keep their assigned `--session-id` |

### Real Claude Code contract (smoke test)

- Hooks passed with `--settings` fire: `SessionStart` arrives with the FlowDeck-assigned session id.
- MCP passed with `--mcp-config` loads: `/mcp` shows `✔ flowdeck  3 tools`.
- The user's `settings.json` and `~/.claude.json` are not modified.

## Security checks

| Check | Result |
|---|---|
| Snyk Open Source, 4 projects | 0 vulnerable paths |
| `pnpm audit` (prod and dev) | 0 known vulnerabilities |
| Snyk Code (SAST) | 2 × "HTTP instead of HTTPS" (CWE-319) on the Unix-socket server/client. **Reviewed false positive**: traffic is local IPC over an `AF_UNIX` socket (mode 0600, directory 0700) and never reaches a network; TLS would add nothing. No other findings |
| Snyk Secrets | Not enabled for the organisation (HTTP 403); no secrets are stored in the repository |
| Independent code review | 8 issues found and fixed with regression tests (see `DESIGN-REVIEW.md`, V1–V8) |
| Renderer isolation (E2E) | No `require`/`process`; bridge exposes only `invoke`/`send`/`on`; unknown channels refused; `fetch('https://…')` blocked; `sandbox`, `contextIsolation` on, `nodeIntegration` off |
| Socket (unit) | 0600; missing/unknown/wrong token → 401/403 with no difference between unknown node and wrong token; oversized body → 413; invalid JSON → 400 |
| Agent messaging (integration) | No edge / wrong direction / forged token / > 4,000 chars / rate limit / skip-permission escalation all refused; escape sequences, invisible characters and forged `[from:]` headers neutralised; cut edges drop their queue; concurrent deliveries never swap text |
| Process hygiene (unit + E2E) | tmux server holds no Electron/Chromium descriptors |
| Packaging | AppImage and .deb build; packaged binary starts, creates a 0600 socket and runs `flowdeck-mcp` with its own runtime; the .deb sets up Chromium's sandbox and AppArmor profile |

## Bugs found and fixed during verification

1. tmux server inherited ~90 Chromium descriptors (kept the profile locked) — fixed (I1).
2. Liveness check race marked new nodes dead — fixed (V1).
3. `--resume` of a never-prompted node would fail — fixed (I2).
4. Delivery buffer collision, forgeable origin header, incomplete bypass detection, queues surviving
   edge removal, delivery into startup dialogs — fixed (V2–V6).

## Not verifiable here

See `docs/MANUAL-CHECKS.md`: real `/login` on two accounts, desktop notifications on a real
desktop, `ccusage` comparison, a physical reboot and a menu-launched `.deb` install.

---

# 0.2.0 — Codex, Kiro, Terminals panel, faster node creation

State on 2026-10-25 (Claude Code 2.1.309, Codex CLI 0.164.0, Kiro CLI 2.23.1 not logged in).
Plan, design validation and task list: `docs/FEATURE-AGENTS-AND-TERMINALS.md`.

| Suite | Result |
|---|---|
| Shared + MCP stdio (now incl. `--identity` hardening) | 10 / 10 |
| App unit (adapters, argv normalisation, skip-approval detection, migration v1→v2 with data, events) | 78 / 78 |
| App integration (real tmux + fakes for Claude, Codex, Kiro) | 33 / 33 |
| E2E (Playwright): previous 5 + Ctrl+Shift+N, Codex/Kiro creation, "How many", Terminals panel + legend + live states, duplicate (panel and Ctrl+Shift+D) | 9 / 9 |
| Real CLIs, no prompt: Claude hooks + MCP; Codex shows all 6 FlowDeck hooks installed (`/hooks`) and `flowdeck: connected (3 tools)` | 2 / 2 |
| Snyk Open Source (4 projects), `pnpm audit` | 0 vulnerabilities |
| Snyk Code | the known CWE-319 false positive (Unix socket), plus a low "path traversal" on `flowdeck-mcp --identity`, mitigated (absolute `identity.json`, regular file, own uid, 0600) and accepted |
| Independent code review | 7 findings, all fixed with regression tests (F1–F7 in the feature doc), including a pre-existing token exposure through tmux's command line |
| Packaging | `flowdeck-0.2.0-amd64.deb` / `.AppImage` built; packaged binary smoke-tested |

Upgrade from 0.1.0: the database migrates automatically (verified with a v1 database holding
nodes, edges and statuses). Sessions started by 0.1.0 keep working; each node gets a new token
the next time it is (re)launched.

# 0.3.0 — exact mouse selection, Linux clipboard, scrollback, renaming, canvas groups and texts

State on 2026-10-26. Plan, design validation and task list: `docs/FEATURE-CANVAS-AND-CLIPBOARD.md`.

| Suite | Result |
|---|---|
| Shared + MCP stdio | 10 / 10 |
| App unit (+ migration v2→v3, drawings CRUD, paste sanitising, OSC 52 parsing, scrollbar geometry) | 89 / 89 |
| App integration (+ drawings validation and restart, tmux scrollback commands, idempotent config reload) | 35 / 35 |
| E2E (Playwright): previous 9 + selection at 100/80/150 % zoom, OSC 52 from programs ignored, middle click and Ctrl+Shift+V, scrollbar + typing leaves scrollback, rename (header and panel), group selection and drag, drawn group + text survive reload, Delete rules | 19 / 19 |
| Snyk Code | no finding in the new code; the known items above are unchanged |
| `pnpm audit` | 0 vulnerabilities (no dependency added) |

One unexplained failure of the app suite in 13 consecutive runs (not reproduced in the next 12).

Fixed while testing: the **Fit** button did nothing (React Flow's queued `fitView` never ran with
our controlled nodes; now `fitBounds`), and controlled nodes lacked their measured size. The tmux
settings are re-applied to an already running FlowDeck tmux server on start, so existing sessions
get the new scrollback and clipboard behaviour without a restart.

