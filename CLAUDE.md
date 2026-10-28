# FlowDeck

Electron app that orchestrates Claude Code sessions on a canvas. Full spec: `docs/spec.md`.
Design decisions that override the spec: `docs/DESIGN-REVIEW.md`.

## Rules
- Strict TypeScript in every package; no `any`.
- Event, state and IPC types live only in `packages/shared`.
- The renderer never touches Node; everything goes through the preload bridge (allow-listed channels).
- Every tmux call uses `-L <socket>` and goes through `packages/app/src/main/tmux`.
- The renderer may write the clipboard but never reads it: pastes are done by main (`pty:paste`).
  Only exception: when the user presses the quick-launch shortcut, main reads the selection once and
  hands it to the quick-launch window (`main/quick`).
- Each window owns its IPC channels: the quick-launch window may invoke only `QUICK_CHANNELS`, and
  the main window never those.
- The renderer never opens links: Ctrl+click sends `link:open`, and main opens only http(s) URLs
  without credentials (`main/links.ts`) in the user's browser.
- Child processes use argv (`execFile`/tmux multi-arg), never shell strings built from user data.
- Never read Claude Code credential files; only check that `.credentials.json` exists.
- Never modify an account's `settings.json`; hooks and MCP are injected per launch with `--settings` / `--mcp-config`.
- No outbound network requests.
- Claude Code internal formats are parsed only in `main/usage` (JSONL) and `main/events` (hooks), with tests.
- Everything specific to one agent CLI (flags, accounts, skip-approval detection, resume) lives in
  `main/agents/<agent>.ts` behind the `AgentAdapter` interface.
- Node tokens never go into argv or the environment: only the path of the 0600 identity file does.
- A launched node's task reaches an agent only as its CLI's first-prompt argument, after `--`, on the
  first launch only. FlowDeck never types into an agent that is still starting, because it could
  answer a trust or skip-permissions dialog.
- Each change ends with `pnpm typecheck && pnpm test` passing; UI changes also `pnpm e2e`.

## Commands
- `pnpm dev` — app in development mode
- `pnpm test` — Vitest (unit + integration with real tmux and a fake `claude`), run under Electron's Node
- `pnpm e2e` — Playwright driving the built Electron app
- `pnpm build` — AppImage and .deb in `packages/app/release`
- `FLOWDECK_REAL_AGENTS=1 pnpm --filter @flowdeck/app test -- real-agents` — opt-in smoke tests against the installed `claude` and `codex` (no prompt, no tokens, no hook trust recorded)

## Notes
- Native modules (better-sqlite3, node-pty) are built for Electron's ABI (`postinstall`); tests run with
  `ELECTRON_RUN_AS_NODE=1 electron vitest`, so there is a single ABI.
- `tests/fixtures/fake-agent.sh` (symlinked as fake-claude/fake-codex/fake-kiro) emulates each CLI's flags and hooks.
- Test isolation env vars: `FLOWDECK_DATA_DIR`, `FLOWDECK_SOCK_PATH`, `FLOWDECK_TMUX_SOCKET`,
  `FLOWDECK_CLAUDE_BIN`, `FLOWDECK_CODEX_BIN`, `FLOWDECK_KIRO_BIN`, `FLOWDECK_SKIP_SHELL_ENV`, `FLOWDECK_HIDE_WINDOW`, `FLOWDECK_DISABLE_NOTIFICATIONS`,
  `FLOWDECK_TEST_CLIPBOARD` (in-memory clipboard, so E2E never touches the user's),
  `FLOWDECK_TEST_LINKS` (links are recorded instead of opening a browser),
  `FLOWDECK_TEST_SHORTCUTS` (global shortcuts are never grabbed; E2E must always set it).
