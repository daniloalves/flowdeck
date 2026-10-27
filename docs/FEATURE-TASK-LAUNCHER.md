# Feature: node templates and a task launcher

Status: **implemented** (0.4.0). Requested on 2026-10-26:
- Node templates that save a node's settings: title, working directory, account, extra arguments,
  terminal size, and so on.
- A **Launch** panel on the right: pick a template, set the title, write a task. The node is created
  from the template, and the task is entered as soon as the agent is ready.

## 1. Understanding

| Question | Finding |
|---|---|
| What already exists? | `node:create` takes `kind, title, cwd, accountId, launchArgs, layout`. A template is a saved copy of that input plus a size. The New Node dialog only remembers the last choices, per agent kind, in `localStorage` |
| Can FlowDeck type into a node? | Yes. `Tmux.pasteAndSubmit` (load-buffer → paste-buffer → Enter) already delivers agent messages |
| Does FlowDeck know when an agent is "ready"? | **No reliable signal.** Claude's `SessionStart` can fire while a startup dialog is still on screen: folder trust, the skip-permissions warning, or Codex's hook review. That is why deliveries wait for `Stop` or the idle reminder, which can be about 60 s away. Typing then could answer a dialog: Enter on "Yes, I trust this folder". Kiro has no hooks at all |
| Can the agent take the task itself? | **Yes, all three installed CLIs take a first prompt as an argument** and start interactively with it: `claude [options] [prompt]` (2.1.311), `codex [OPTIONS] [PROMPT]` (0.164.0), `kiro-cli chat [OPTIONS] [INPUT]` (2.23.1). The agent then deals with its own startup and dialogs |
| Limits of passing it on the command line | tmux carries a command in one message of about 16 KB; a 12 000-byte argument works and a 20 000-byte one fails ("command too long", verified). Any local user can read a process's arguments through `/proc/<pid>/cmdline` |
| Restart, resume, duplicate | Launches go through `Core.launchSession` with `firstLaunch`. The task must be passed on the first launch only, never on a restart or resume |
| Shell nodes | No CLI argument. A shell reads typed-ahead input once it starts, so the task can be pasted right after the session exists |

**Verdict: feasible.** It is roughly the size of the canvas-annotations feature. It needs one new
table, about five IPC channels, a panel, and a small change in each agent adapter. Nothing here
touches credentials or `settings.json`, and nothing makes network requests. The user approved it
with a **12 KB** task limit.

### Spike with the real CLIs (P0)

Run in a scratch folder on an isolated tmux socket, with a one-word prompt ("reply PONG"):

| CLI | Finding |
|---|---|
| Claude Code 2.1.311 | `claude -- "<task>"` in an untrusted folder first shows the trust dialog, whose **default answer is now "No, exit"**. After "Yes, I trust this folder" the task runs as the first prompt. Typing the task instead would have answered the dialog. **`claude -- mcp` still runs the `mcp` subcommand** (R4 confirmed) |
| Codex 0.164.0 | `codex -- "<task>"` runs the task. With new hooks it first shows "Hooks need review"; after "Continue without trusting" the task still runs. `codex -- completion` is a prompt, not the subcommand |
| Kiro 2.23.1 | Not run: the CLI is not logged in on this machine. Its help shows `chat [OPTIONS] [INPUT]` with no subcommands, so it is expected to behave like Codex (manual check 14) |
| tmux 3.4 | One command carries at most about 16 KB: a 16 319-byte argument fits and a 20 000-byte one fails with "command too long" |

Side effect of the spike: Claude Code recorded trust for the deleted scratch folder in
`~/.claude.json`. Nothing else was changed, and Codex's hook trust was not recorded.

## 2. Design

### Templates
- Fields: name, agent (Claude/Codex/Kiro/Shell), working directory, account (for agents that have
  accounts), extra arguments, size on the canvas (w × h), and an optional default title.
- Managed in the Launch panel: new, edit, duplicate, delete. The New Node dialog also gets
  **Save as template**.
- They are checked when they are used, not only when saved. A deleted account, a missing directory,
  or a now-reserved argument gives a clear error and no node.

### Launch panel (right side, next to Terminals / Accounts / Messages)
- Template picker, Title (the template's default title or the folder name is shown as the
  placeholder; a title already used on the canvas gets ` #2`, ` #3`…), and a multi-line **Task**
  box with a byte counter.
- **Launch** (Ctrl+Enter) creates the node and shows it on the canvas. The task appears as the
  agent's first prompt.
- A template that skips approvals is marked with the existing skip-approval badge. Launching a task
  into one means the agent works on it without asking.
- An empty task is allowed: the node is simply created from the template.

### How the task gets in
| Kind | Method |
|---|---|
| Claude, Codex, Kiro | Passed as the CLI's first-prompt argument, after `--` so it is never read as an option. First launch only |
| Shell | Pasted with `pasteAndSubmit` right after the session is created |

### Explicitly out of scope
- Agents launching nodes through MCP: that would let an agent create agents, possibly ones that
  skip approvals.
- Scheduled or recurring launches; a task queue; edges created automatically.

## 3. Architecture

| Layer | Change |
|---|---|
| `packages/shared` | `NodeTemplate` type and `templateInputSchema` (used for create and update). `newNodeSchema` gets an optional `task` (`LIMITS.taskBytes` = 12 KiB of UTF-8; no control characters except newline and tab). New IPC channels `template:create/update/delete`. The snapshot carries the templates |
| `main/db` | Migration v4: a `node_template` table (`id, name, kind, cwd, account_id, launch_args JSON, w, h, title, created_at`). Repo CRUD. At most 200 templates |
| `main/core.ts` | `createNode` passes `task` to the first launch only. Template CRUD validates like `createNode` (directory, account kind, reserved arguments) |
| `main/agents/*.ts` | `LaunchContext` gains `task?: string`, and `AgentAdapter` gains `taskError(task)` (Claude refuses a one-word task, see R4). Each adapter appends `['--', task]` on a fresh first launch only, never on a resume. Codex and Kiro already reject a positional first argument in the user's extra arguments, so the task stays the only one |
| `main/tmux` | `buildNewSessionArgs` refuses a command over 16 000 bytes with a clear message ("shorten the task or the extra arguments"), instead of tmux's "command too long" |
| `main/ipc.ts` | Template handlers; `node:create` accepts `task`. Handlers are now one typed object with an entry per channel, so a channel without a handler is a type error |
| Renderer | `panels/LaunchPanel.tsx` (form and template list), `panels/TemplateDialog.tsx`, and `panels/nodeFields.tsx` (fields shared with `NewNodeDialog`, which gains **Save as template…**). Store slices; `Ctrl+Shift+L` toggles the panel |
| Tests | Unit: schemas, the migration, and adapter argv (task only on a fresh start, after `--`, never on a resume). Integration with the fake agents: the task reaches the CLI as its prompt argument, and a restart does not resend it. E2E: create a template, launch, the node appears and the fake agent received the task |

### Risks and decisions
| # | Risk / alternative | Decision |
|---|---|---|
| R1 | Wait for "ready" and type the task (option B) | **Rejected** for agents: there is no reliable ready signal, and typing could answer a trust or skip-permissions dialog. The CLIs' own first-prompt argument avoids both problems |
| R2 | The task can be read by other local users through `/proc/<pid>/cmdline` | **Accepted and documented**: FlowDeck targets single-user desktops. The UI says the task is visible to local processes. Tokens and credentials are never involved |
| R3 | tmux's limit of about 16 KB per command | Task capped at **12 KiB** of UTF-8 (the user's choice), checked by the schema in main. The whole tmux command is also checked (16 000 bytes): a 12 KiB task plus very long extra arguments is refused with a clear message, and no node is left behind |
| R4 | A task that is exactly a subcommand name: `claude -- mcp` runs the subcommand (**confirmed**) | Claude refuses a one-word task that looks like a command name (`mcp`, `update`, `plugin:install`). Sentences and `/commands` pass. Codex and Kiro are not affected |
| R5 | Whether each CLI keeps the first prompt while a startup dialog is shown | **Confirmed** for Claude (folder trust) and Codex (hook review). Kiro: manual check 14 |
| R6 | A template keeps pointing at a deleted account or folder | Checked at launch with a clear error; the template is flagged in the list |
| R7 | Template data stored in `localStorage` | **Rejected**: it lives in SQLite with the rest of the layout, so it survives a reset and is checked in main |

## 4. Execution plan

| # | Task | Done when |
|---|---|---|
| P0 | **Spike** with the real CLIs (approved by the user): the first prompt after `--` is accepted and survives the trust dialog and Codex's hook review; check R4 | done; R4 confirmed and handled |
| P1 | Shared types and schemas, `task` in `newNodeSchema`, IPC types | typecheck |
| P2 | Migration v4, repo, core template CRUD with validation | unit and integration tests |
| P3 | Adapters: `task` on a fresh start only; shell paste | unit tests (argv) and integration tests (fake agents record their argv) |
| P4 | Launch panel, template editor, Save as template | E2E |
| P5 | Docs (README usage, CHANGELOG, VERIFICATION, MANUAL-CHECKS), Snyk, full test run, build | all green |

## 5. Implementation results

All tasks are done; results in `docs/VERIFICATION.md` (0.4.0).

- Tests added:
  - unit: schema byte limit and control characters, adapter argv (task last, after `--`, fresh
    first launch only), Claude's one-word rule, tmux command size, migration v3→v4, template CRUD
    with a deleted account;
  - integration (real tmux, fake agents that now read a first prompt after `--`): template
    checks; Claude, Codex, Kiro and Shell launches with a task; a 12 KiB multi-byte task arriving
    intact; no resend on restart; refused launches leave no node or session;
  - E2E: Save as template, Ctrl+Shift+L, Launch with Ctrl+Enter, unique titles, the 12 KB limit
    in the UI, a refused task, editing and deleting templates.
- Found while testing and fixed: the template handlers were missing in main, but typecheck passed
  because nothing required a handler per channel. IPC handlers are now one typed object, so a
  missing handler is a type error (verified by removing one).

### Known limitations
- The task can be read by other local processes while the agent runs (R2).
- Kiro's behaviour with a first prompt was not tried with a real login (manual check 14).
- A Shell task is typed ahead before the shell is ready; its echo can appear before the prompt.
