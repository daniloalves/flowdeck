# Feature: quick launch from any window

Status: **implemented** (0.5.0). Requested on 2026-10-27: "in any window on my computer, select
text anywhere, press a shortcut, see FlowDeck's templates and launch a new task from that window:
Chrome, Firefox, a text editor, VS Code, Teams…". The user's choices:
- shortcut **Ctrl+Alt+F**;
- templates get a **task text with `{{selection}}`**;
- after launching, **stay in the app you came from**, with a setting to go to FlowDeck instead;
- added while it was being built: an optional **Group** field, so the node is created inside an
  existing group.

## 1. Understanding

| Question | Finding |
|---|---|
| Desktop | Ubuntu 24.04, GNOME 46, **X11** session, Electron 44 |
| Can FlowDeck get a key press while another app has focus? | Yes on X11: Electron's `globalShortcut` grabs the key on the X server. Spike: registering works and the key is free. GNOME 46 binds nothing to Ctrl+Alt+F (checked with `gsettings`) |
| Does Electron say when a key is already taken? | **No.** The spike registered Ctrl+Alt+T and Super+L, which GNOME owns, and `register()` still returned true. FlowDeck cannot detect a conflict, so the shortcut can be changed in the Launch panel |
| Can FlowDeck read the text selected in another app without a copy? | Yes. On Linux, selected text is the X11 **PRIMARY** selection, the same one middle-click pastes. FlowDeck already reads it for middle-click paste. Chrome, Firefox, VS Code, Teams, editors and terminals all set it |
| Selection empty | Some apps do not set PRIMARY; the user may also have copied with Ctrl+C. Fall back to the clipboard and say so |
| Stale selection | PRIMARY keeps the last selection anywhere until something else is selected, so the text is always shown before launching |
| Will the popup get focus? | Yes. In the spike, a frameless always-on-top window shown with no user event at all got focus on GNOME (X11). A key press only makes this more likely |
| Wayland, or FlowDeck not running | Electron global shortcuts need a portal on Wayland, and nothing is registered when FlowDeck is closed. A `flowdeck --quick-launch` command reaches the running FlowDeck (single-instance lock), or starts it. It can be bound to a GNOME custom shortcut |
| macOS | No PRIMARY: the text comes from the clipboard (Cmd+C, then the shortcut). The global shortcut works |
| What exists already | Templates, the Launch panel, the first task passed as the CLI's first prompt after `--`, and a 12 KiB limit (0.4.0) |
| Risk | The selected text is untrusted. A web page can hold instructions aimed at an agent, and a template may skip approval prompts |

**Verdict: feasible on this desktop**, with no new dependency.

## 2. Design

### The popup
1. Select text in any app and press **Ctrl+Alt+F**.
2. A small FlowDeck window opens near the mouse pointer, above other windows. It shows:
   - where the text came from: *selection*, *clipboard (nothing was selected)*, or *nothing*;
   - the templates, filtered as you type in the search field (↑/↓ to pick);
   - an optional title (the default is the template's title or its folder name, made unique);
   - an optional **Group**: the node is created inside it;
   - the text, editable;
   - a preview of the task that will be sent when the template has its own task text;
   - a byte counter (12 KB limit).
3. **Enter** (or Ctrl+Enter from the text) launches; **Esc** or clicking elsewhere closes it.
4. By default the popup closes and you stay in the app you came from. A desktop notification says
   the node was launched; clicking it shows the node. Setting: *After a quick launch: stay in the
   app I came from / go to FlowDeck*.

### Template task text
- Templates get an optional **Task** field. `{{selection}}` is replaced by the selected text, or
  by what is typed in the Launch panel. Without `{{selection}}`, the text is added after a blank
  line. An empty task field sends the text alone.
- Example: `Investigate this error and propose a fix:\n\n{{selection}}`.
- The Launch panel uses the same rule, so a template behaves the same both ways.

### Groups
- A node belongs to a group when it lies fully inside the group's rectangle (that is what moves
  with the group). A node launched into a group goes to the first free spot inside it: next to or
  below what is already there, never under a text.
- When the group is full, it **grows downwards** (and wider for a node wider than the group) so the
  node fits. Growing can take in something that was just below the group; it can be dragged out.
- The Launch panel has the same field. The last group chosen is remembered (per viewer), like the
  last template.

### Safety
- Nothing launches without an explicit Enter or click in the popup, after the text is shown.
- A template that skips approval prompts is marked. Launching it needs a **second
  confirmation**: the button turns into "Launch without approvals" and has to be pressed again.
- The selection is read **only when the shortcut or `--quick-launch` is used**, never in the
  background, and is given only to the popup.
- The popup window can only use its own three channels. It cannot create nodes directly, delete
  them or type into them. The main window cannot use the popup's channels either.
- The text still travels as the CLI's first prompt after `--`, under the existing 12 KiB limit.

### Settings (Launch panel, "Quick launch")
- **Shortcut:** click the field and press a combination (Ctrl, Alt or Super plus a key), or turn it
  off. Default Ctrl+Alt+F. If pressing it does nothing, another app owns it: pick another.
- **After a quick launch:** stay in the app / go to FlowDeck.

### Out of scope
- The source window's title or URL, which would need X11-only tools and is not available on
  Wayland.
- Keeping FlowDeck running with no window (tray). Closing FlowDeck still quits it;
  `flowdeck --quick-launch` starts it again.

## 3. Architecture

| Layer | Change |
|---|---|
| `packages/shared` | `NodeTemplate.task`; `templateInputSchema.task`. `launch.ts`: `composeTask()`, `uniqueTitle()`, `folderName()`, `spotNear()`, `placeInGroup()` and the group margins (shared by main and the canvas). `AppSettings` (`quickLaunch.shortcut`, `quickLaunch.afterLaunch`), `settingsPatchSchema`, `acceleratorSchema` plus helpers to build and show an accelerator. `templateLaunchSchema` and `quickLaunchSchema`. New channels: invoke `template:launch`, `settings:update`, `quick:state`, `quick:launch`, `quick:close`; events `quick:show` and `annotation:changed` (a group grew). The snapshot gets `settings` and `env.quickShortcutActive` |
| `main/db` | Migration v5: `node_template.task`. Settings are a JSON value in `app_state`, validated when read |
| `main/core.ts` | `launchTemplate()`: composes the task, makes the title unique (serialised with Duplicate), places the node inside a group (growing it) or at a given centre, and emits it. `describeTemplates()`: the skip-approvals flag and problems (missing account or CLI) for the popup. `settings()` / `updateSettings()` |
| `main/quick/selection.ts` (new) | `normalizeSelection()` (CRLF to LF, no other control characters, length cap). `readSelection()` (PRIMARY, then the clipboard). `wantsQuickLaunch(argv)`. `systemShortcuts()` / `memoryShortcuts()` (tests: `FLOWDECK_TEST_SHORTCUTS=1`, never grabs real keys) |
| `main/quick/window.ts` (new) | `QuickLaunch`: the popup window (created on first use and then reused, hidden on blur), the pending state, the global shortcut and what happens after a launch |
| `main/ipc.ts` | Each invoke channel belongs to one window: `quick:*` to the popup, the rest to the main window |
| `main/index.ts` | Wires `QuickLaunch`; `--quick-launch` on start and from a second instance; the popup is closed with the main window, so FlowDeck still quits |
| Renderer | `quick/QuickLaunch.tsx` (the popup, the same bundle loaded with `#quick`); `panels/launchShared.tsx` (the group field, the task preview, the remembered choices). The Launch panel uses `template:launch`, shows the task preview, and gets a "Quick launch" section with the shortcut field and the after-launch choice. `TemplateDialog` gets the Task field |
| Tests | Unit: composition, titles, accelerators, selection normalisation, argv. DB: migration v5 and settings. Integration (real tmux, fake agents): `launchTemplate` sends the composed task and handles titles, placement and errors. E2E: shortcut → popup with the selection or the clipboard → launch; skip-approvals confirmation; Esc; settings; each window limited to its channels |

### Alternatives considered
| # | Alternative | Decision |
|---|---|---|
| A1 | Simulate Ctrl+C in the source app to read its selection | **Rejected**: it overwrites the user's clipboard and needs `xdotool`. PRIMARY already holds the selection |
| A2 | Only a GNOME custom shortcut running `flowdeck --quick-launch` | **Kept as a fallback** (Wayland, FlowDeck closed). Starting a process per press is slower than a registered shortcut |
| A3 | A second HTML entry for the popup | **Rejected**: the same bundle with `#quick` keeps one CSP and one preload, and `isTrustedUrl` is unchanged |
| A4 | Launch directly from the shortcut with the last template | **Rejected**: untrusted text has to be seen before it reaches an agent |
| A5 | Store settings in `localStorage` | **Rejected**: main needs the shortcut before any window loads |

## 4. Execution plan

| # | Task | Done when |
|---|---|---|
| Q0 | Spike: register the shortcut, check conflicts and popup focus on this desktop | done (see Understanding) |
| Q1 | Shared types, schemas and helpers | unit tests |
| Q2 | Migration v5, settings, `launchTemplate`, `describeTemplates` | DB and integration tests |
| Q3 | `main/quick/`, IPC split per window, `--quick-launch` | unit and E2E |
| Q4 | Popup UI, Launch panel settings and preview, Task field in templates, Group field | E2E |
| Q5 | Docs, Snyk, full test run | all green |

## 5. Implementation results

All tasks are done; results in `docs/VERIFICATION.md` (0.5.0).

- The per-window IPC split is tested from both sides: the quick-launch window gets "untrusted
  sender" for `node:create` and `app:snapshot`, and the main window gets it for `quick:*`.
- Title uniqueness moved from the renderer to main (`launchTemplate`), serialised with Duplicate,
  so two quick launches in a row never get the same title.
- The group geometry (`inside`, margins) moved to `packages/shared`, so the canvas and main agree on
  what "inside a group" means.

### Known limitations
- Electron cannot tell when another app owns the shortcut: if pressing it does nothing, choose
  another one in the Launch panel.
- With FlowDeck closed nothing is registered; `flowdeck --quick-launch` from a desktop shortcut
  starts it.
- Not verified on a real desktop yet: focus going back to the source app after a launch, and the
  window staying open while its dropdowns are open (manual check 16).
