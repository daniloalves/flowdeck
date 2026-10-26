# Feature: Codex & Kiro nodes, Terminals panel, faster node creation

Requested on 2026-10-25:
1. A third panel next to **Accounts** and **Messages** to control the terminals and see their
   status as coloured bullets, with a legend.
2. A shortcut / feature to create more nodes quickly.
3. Codex and Kiro as node types, next to Claude Code and Shell.

## 1. Facts verified on this machine (before designing)

| Question | Codex CLI 0.155.1 → 0.164.0 (it auto-updated during the probe) | Kiro CLI 2.23.1 |
|---|---|---|
| Inject config per launch, without touching user files | **Yes**: `-c key=value` (TOML). Verified `-c hooks.<Event>=[…]` is discovered and `-c mcp_servers.<name>.command/args` connects (`fdprobe: connected (3 tools)`) | **No** verified way: agents (hooks + MCP) are files in `~/.kiro/agents` or `<cwd>/.kiro/agents`; the format is changing (2.x object hooks → V3 `~/.kiro/hooks/*.json`) |
| Hook events | `SessionStart` (`source`), `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, `Interrupt`, `SessionEnd`, … — every payload carries `session_id` (UUIDv7) and `hook_event_name` | `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`; stdin schema not documented |
| Hooks inherit the environment | **Yes** (verified: `FLOWDECK_NODE_ID` visible in the hook) | Unknown |
| When `SessionStart` fires | Lazily, with the **first prompt** (no thread before that) | — |
| Hook trust | Non-managed hooks need a one-time **trust** (stored by hash). On first launch Codex shows "Hooks need review → Trust all and continue". FlowDeck's hook commands are identical for every node, so trust is needed once per Codex home | — |
| Resume | `codex resume <SESSION_ID>`, `codex resume --last` (cwd-filtered) | `--resume-id <ID>`, `--resume` (most recent in cwd) |
| Multiple accounts | `CODEX_HOME` (default `~/.codex`), login = `auth.json` | No supported variable; one system login |
| Skip-approval flags | `--dangerously-bypass-approvals-and-sandbox`, `-a/--ask-for-approval never`, `--approve-for-me`, `approval_policy = "never"` | `-a/--trust-all-tools`, `--trust-tools=<list>` |
| Login state here | Logged in | **Not logged in** |
| Terminal activity | tmux `#{window_activity}` updates on every pane output (1 s resolution), no option needed | same |

## 2. Design

### 2.1 Agent adapters (main process)
Everything specific to one CLI moves behind one interface, so a format change breaks one file:

```
main/agents/types.ts    AgentAdapter interface
main/agents/claude.ts   existing behaviour, moved
main/agents/codex.ts    -c hooks + -c mcp_servers, CODEX_HOME accounts, resume <id>
main/agents/kiro.ts     activity status, --resume, no accounts, no MCP (yet)
main/agents/index.ts    registry
```

`AgentAdapter` = binary name, account directory pattern + credential file name (existence only),
account env, status source (`hooks` | `activity`), reserved arguments, skip-permission detection,
start plan (new / resume / continue) and argv builder.

### 2.2 Status sources
- **hooks** (Claude, Codex): `hook.sh` → socket → state machine. New canonical events:
  `PermissionRequest` → `needs_input`, `Interrupt` → `idle` (this also fixes the Codex "Esc" case).
  The session id is accepted from `SessionStart`, and from any event while the node has none
  (Codex only reveals it with the first prompt).
- **activity** (Kiro): the existing 2 s liveness poll also reads `#{window_activity}`;
  output in the last 3 s → `working`, quiet for 5 s → `idle` (hysteresis avoids flicker).
  `needs_input` cannot be detected for Kiro and is documented as such.

### 2.3 MCP identity file
`flowdeck-mcp --identity <file>` reads `{nodeId, token, socketPath}` from a per-node 0600 file.
The argv of the agent therefore only carries a path (Codex `-c` values are visible in `ps`).
Claude switches to the same mechanism; the environment fallback stays for compatibility.

### 2.4 Data model (migration v2)
- `node.kind` adds `codex`, `kiro` (table rebuild, foreign keys preserved).
- `node.claude_session_id` → `node.session_id` (agent-neutral).
- `account.agent` (`claude` | `codex`, default `claude`); a node's account must match its agent.
- Discovery lists `~/.claude*` and `~/.codex*` directories.

### 2.5 UI
- **Terminals panel**: legend (state colours, red ring, queued tag), live counts, one row per node
  (bullet, title, type, account, state, queue) sorted by "needs attention first", with actions
  *Go to*, *Duplicate*, *Resume* (stopped) and *Close*.
- **Faster creation**: one **+ New node** button (`Ctrl+Shift+N`) whose dialog offers
  Claude / Codex / Kiro / Shell (disabled when the CLI is missing), remembers the last choices and
  has a **Count** field (1–6) to create several nodes in a grid; **Duplicate** (`Ctrl+Shift+D` on the
  selected node, header button, panel action) clones type, directory, account and arguments into
  a new session next to the original.
- Shortcuts are handled at window level and excluded from xterm so they never reach the terminal.

## 3. Design validation

| # | Risk / alternative considered | Decision |
|---|---|---|
| D1 | Writing a FlowDeck agent into `~/.kiro/agents` would give Kiro hooks + MCP | **Rejected for now**: breaks "never modify account config" (H1), the 2.x→V3 format is moving, the stdin schema is undocumented and Kiro is not logged in here, so it could not be verified. Kiro gets activity status and can **receive** messages; sending from Kiro is a follow-up once it can be verified |
| D2 | `--dangerously-bypass-hook-trust` would avoid Codex's trust prompt | **Rejected**: it disables trust for *every* hook, including repository hooks. FlowDeck tells the user to trust once; the flag is reserved so it cannot be passed as an extra argument either |
| D3 | Token in Codex `-c mcp_servers.*.env` | **Rejected**: argv is world-readable in `ps`; identity file instead (2.3) |
| D4 | Codex node "starting" until the first prompt (lazy `SessionStart`) | Codex nodes start as `idle` once launched; hooks refine the state from the first prompt |
| D5 | `--continue`-style resume picking the wrong conversation | Same rule as Claude: `resume --last` / `--resume` only when no other node of the same agent shares cwd + account, otherwise a fresh session |
| D6 | Activity heuristic marking a node "working" for unrelated output (resize redraws, typing echo) | Hysteresis (3 s / 5 s), applied only to Kiro; message delivery still also requires "not focused" |
| D7 | Skip-approval detection per agent | Each adapter lists its flags; Codex also reads `approval_policy` from `$CODEX_HOME/config.toml` (read-only, top-level key). The edge rule is unchanged: normal → skip-approval is refused |
| D8 | Account id clashes (`~/.claude` and `~/.codex` both "default") | Codex suggestions are `codex`, `codex-<name>` |
| D9 | `OPENAI_API_KEY` / `CODEX_HOME` in the parent env overriding the chosen account | Stripped from the tmux environment, like the Anthropic variables |
| D10 | Shortcuts colliding with terminal programs | Only `Ctrl+Shift+N` / `Ctrl+Shift+D`, filtered out of xterm with a custom key handler |
| D11 | Usage for Codex / Kiro | Out of scope; badges show the account and "usage n/a" |

## 4. Task list

| # | Task | Done when |
|---|---|---|
| T1 | Shared types: `NodeKind`, `AgentKind`, `Account.agent`, `sessionId`, agent availability in `Environment`, new hook events, schemas | typecheck |
| T2 | DB migration v2 (rebuild `node`, rename column, `account.agent`) + repo | unit test migrates a v1 database with data |
| T3 | Agent adapters (Claude moved, Codex, Kiro) + registry; Core uses them | unit tests for argv, reserved args, skip-approval detection |
| T4 | Hooks: `hook.sh` allow-list, state machine (`PermissionRequest`, `Interrupt`, session id rules) | unit tests |
| T5 | Activity status for Kiro in the liveness poll | integration test |
| T6 | `flowdeck-mcp --identity`; per-node identity file; Claude + Codex use it | MCP stdio test |
| T7 | Accounts: discovery of `~/.codex*`, agent-aware panel, env stripping | unit + E2E |
| T8 | Fake Codex / Kiro for tests (one script, three personalities) | integration tests for both |
| T9 | UI: **+ New node** dialog with all types, Count, remembered choices; Duplicate (button, panel, `Ctrl+Shift+D`); `Ctrl+Shift+N` | E2E |
| T10 | UI: **Terminals** panel with legend, counts, rows and actions | E2E |
| T11 | Real-CLI smoke: Codex hooks discovered + MCP connected (no prompt) | opt-in test |
| T12 | Security review of the new code, Snyk scans, full test run, package build, docs | all green |

## 5. Execution results

All tasks T1–T12 are done. Verified with fakes for every agent (status, messages, restore,
duplication) and with the **real** Claude Code 2.1.309 and Codex 0.164.0 CLIs (no prompts, except
two one-word probes to Codex while designing: hook environment inheritance and bracketed-paste
delivery).

### Independent review of the new code (all fixed, each with a regression test)

| # | Finding | Fix |
|---|---|---|
| F1 | **Node token in argv** (pre-existing): it was passed as `tmux new-session -e FLOWDECK_NODE_TOKEN=…`, and the tmux server keeps its first command line for its whole life, readable by other users through `ps` | The environment only carries `FLOWDECK_IDENTITY` (path of the 0600 identity file); `hook.sh` and `flowdeck-mcp` read the token from it. Tokens are **rotated on every launch**, so a token exposed by 0.1.0 stops working once the node is reopened |
| F2 | Codex/Kiro nodes started as `idle`: a queued message could be typed into a start-up dialog (e.g. Codex's folder-trust prompt, where Enter accepts) | They start as `starting`; Codex becomes deliverable on its first hook event, Kiro after its start-up output settles |
| F3 | Skip-approval detection missed attached forms (`-anever`, `-capproval_policy=never`), profiles (`-pX`, `profile = "x"` + `[profiles.x]`, `X.config.toml`), quoted keys and `danger-full-access` | Clap-style argument normalisation; Codex config parsed with a real TOML parser; unparseable config counts as skipping approvals |
| F4 | Kiro agent files were not inspected | `--agent`, `chat.defaultAgent`, workspace and global agent files are read; `allowedTools` with `*`/shell/write/aws, newer permission formats, unknown or unreadable agents count as skipping approvals |
| F5 | FlowDeck-owned Codex options could be overridden with attached or whole-table forms (`-chooks…`, `-c mcp_servers={…}`, `-c features={…}`) | Reserved keys checked after normalisation, including whole tables |
| F6 | Danger verdict only refreshed at launch; duplicate-title race; auto-repeat of Ctrl+Shift+D | Re-checked every 10 s; duplicates serialised; key repeat ignored |
| F7 | Snyk Code: path traversal (low) through `flowdeck-mcp --identity` | Only an absolute, normalised `identity.json` that is a regular file, owned by the user and not readable by others is accepted |

Also found while testing: opening the dialog with the shortcut left the keyboard focus in the
terminal, so Escape and typing went to the agent (fixed: the dialog takes focus and handles
Escape globally); "Go to" in the panel now selects only that node so Ctrl+Shift+D applies to it.

### Known limitations
- Kiro: no "needs you" state and cannot send messages (no hooks/MCP injection without writing
  into `~/.kiro`); approvals switched off at runtime with `/tools trust-all` cannot be seen.
- Codex: until you trust FlowDeck's hooks once (Codex asks; or `/hooks` → `t`), a Codex node stays
  "Starting" and receives no messages. Approval mode changed at runtime with `/approvals` cannot
  be seen.
- Usage figures are shown for Claude Code accounts only.
