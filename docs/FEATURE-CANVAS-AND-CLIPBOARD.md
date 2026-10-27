# Feature: precise mouse selection, Linux clipboard, renaming, canvas groups and text

Requested on 2026-10-26:
1. Selecting terminal text with the mouse picks the wrong line (the pointer tip selects the line below).
2. Ubuntu's middle-click paste does not paste what was selected or copied.
3. A way to rename a terminal.
4. Drawing on the canvas: transparent rectangles that group terminals, and text boxes for captions.

Added the same day:
5. The scrollbar is an ugly yellow bar, not an elegant traditional one.
6. After scrolling up, typing does nothing until you scroll back down; typing should just work.

## 1. Facts verified before designing

| Question | Finding |
|---|---|
| Why is the selected line wrong? | Reproduced with a probe (shell node, `LINE1..15`, drag over the row showing `LINE8`, read tmux's buffer): zoom 100 % → `LINE8`; zoom 80 % (the default) → `LINE6`; zoom 150 % → wrong line too. xterm.js computes the cell as `(clientY − rect.top) / cssCellHeight`: `rect` is measured **after** the canvas' CSS `scale()`, the cell height **before** it. The error grows with the distance from the top of the terminal and with the zoom |
| Who handles the selection? | tmux (`mouse on`): xterm reports mouse events (with the same wrong coordinates), tmux selects in copy mode and copies on release |
| Where does the copied text go? | Into a tmux buffer only. tmux also emits OSC 52 (`set-clipboard external`, default `xterm*:clipboard` feature), but xterm.js ignores OSC 52 without a handler, so the system clipboard never sees it |
| Middle click today | xterm reports it to tmux, which pastes its own buffer (or forwards the click to a program that uses the mouse); the X11 PRIMARY selection is never read |
| Can programs inside a node write the clipboard through tmux? | Not with `set-clipboard external`: tmux only emits OSC 52 for its own copies and ignores applications' OSC 52; `allow-passthrough off` blocks the DCS bypass |
| Clipboard access from the renderer | The renderer is sandboxed: Electron's `clipboard` module is main-process only there, so clipboard access needs IPC |
| Renaming | Already implemented (`node:update { title }`), but only by double-clicking the title: undiscoverable |
| The "yellow scrollbar" | tmux's copy-mode position indicator `[n/m]`, drawn with the default `mode-style bg=yellow,fg=black`; the wheel enters copy mode (`copy-mode -e`). `copy-mode -H` hides the indicator; `#{scroll_position}`/`#{history_size}` and `goto-line` expose and set the position |
| Typing after scrolling up | Keys go to copy mode's key table, not to the program, until copy mode is left |
| Running servers | tmux reads its config only when the server starts; the user's server from 0.2.0 keeps running across upgrades. `source-file` on a running server applies it (and never starts a server) |
| Grouping on the canvas | React Flow 12 has `NodeResizer` and `NodeToolbar`; extra node types render on the same canvas |

## 2. Design

### 2.1 Mouse coordinates under zoom
xterm's mouse service gets the event and the screen element. A small adapter (`terminal/scale.ts`)
wraps `getCoords` and `getMouseReportCoords` and maps the pointer back to unscaled CSS pixels:
`x' = left + (clientX − left) / s`, with `s = rect.width / element.offsetWidth` (measured on every
event, so any zoom works). This reaches into xterm's private `_core._mouseService` (names are kept
in the published bundle); the adapter checks the shape and does nothing if it changes, and an E2E
test at 80 % and 150 % zoom fails if the fix stops applying.

### 2.2 Clipboard (Ubuntu conventions)
- **Selecting copies.** tmux copies on mouse release and emits OSC 52; the terminal registers an
  OSC 52 handler that sends the text to main (`clipboard:write`), which sets both the **PRIMARY**
  selection (middle click) and the **CLIPBOARD** (Ctrl+V in other apps). Queries (`?`) are refused:
  nothing inside a node can read the clipboard. Shift+drag (xterm's own selection) does the same.
- **Middle click pastes PRIMARY**, **Ctrl+Shift+V pastes CLIPBOARD** (GNOME Terminal's keys).
  The click is stopped before xterm/tmux see it. The renderer only sends
  `pty:paste { nodeId, source, bracketed }`; **main** reads the clipboard and writes it to the PTY, so
  the renderer never receives clipboard contents. Pasted text gets xterm's treatment: `\r?\n → \r`,
  bracketed-paste markers when the program asked for them, and any `ESC[201~` inside the text is
  removed so a paste cannot break out of bracketed mode.
- tmux.conf states `set-clipboard external` explicitly (it is the default today).

### 2.3 Renaming
- Pencil button in the node header and in each Terminals-panel row; the existing double-click on
  the title stays. Titles keep the same validation (1–80 chars, no control characters).

### 2.3b Scrollback
- tmux.conf: the wheel and mouse-drag bindings enter copy mode with `-H` (no position indicator);
  `mode-style` uses the canvas' selection colours. FlowDeck re-applies its tmux.conf on start
  (`source-file`), so an already running server gets it; array options are set by index so this is
  idempotent.
- A slim overlay scrollbar per terminal, visible only while scrolled back, reads
  `pty:scrollState` (tmux format variables) after wheel turns; dragging the thumb or clicking the
  track sends `pty:scrollTo` (`copy-mode -eH` + `goto-line`, throttled to one call per 50 ms).
- The first keystroke after scrolling back is sent with `exitScroll`: main leaves copy mode
  (`send-keys -X cancel`) and then writes the key; input is queued per node behind that, so no
  keystroke is lost or lands in copy mode. Mouse and focus reports are not "typing".

### 2.4 Canvas annotations: groups and text
- New table `annotation` (migration v3): `id, kind ('group'|'text'), text, color, font_size, x, y, w, h,
  created_at`. Shared types/schemas; IPC `annotation:create|update|delete`; the snapshot carries them.
  Annotations are only drawings: they never reach agents and never affect messaging.
- **Group**: transparent tinted rectangle with a coloured border and an editable title bar.
  It is dragged by its title bar; its interior lets clicks through (pan, select terminals). Dragging a
  group moves everything fully inside it (terminals, texts, nested groups), like a frame. Resize when
  selected; colour and delete from a toolbar above it. Deleting a group never closes terminals.
- **Text**: free text (multi-line, up to 2000 chars), double-click to edit, size S/M/L/XL, colour,
  drag anywhere on it, width resizable.
- **Creating**: toolbar **▭ Group** (`Ctrl+Shift+G`) and **T Text** (`Ctrl+Shift+X`). With terminals
  selected, *Group* wraps them immediately; otherwise the cursor becomes a crosshair and you drag
  the rectangle (a click gives a default size). `Esc` cancels.
- **Deleting**: toolbar ✕ or Delete/Backspace on a selected annotation. The keyboard still never
  deletes terminals.
- Layering: groups below terminals and edges (negative z-index, also when selected); texts above,
  also above a selected terminal (see `IMPROVEMENT-TEXTS-ON-TOP.md`).

## 3. Design validation

| # | Risk / alternative considered | Decision |
|---|---|---|
| C1 | Render terminals outside the scaled viewport (portal) to avoid the transform | **Rejected**: duplicates layout and breaks zoomed rendering of the canvas; the coordinate adapter is local and tested |
| C2 | Private xterm API may change on upgrade | Guarded (no-op on shape change) + E2E regression at two zoom levels; xterm is pinned by the lockfile |
| C3 | Give the renderer `clipboard:read` | **Rejected**: main does the paste; the renderer can write the clipboard but never read it |
| C4 | Programs in a node writing the clipboard with OSC 52 (clipboard hijacking) | tmux `set-clipboard external` drops applications' OSC 52; FlowDeck accepts OSC 52 only from the tmux client stream. Tested with a program that prints OSC 52 |
| C5 | Paste injection (`ESC[201~` in the clipboard ends bracketed paste and runs the rest as typed input) | Marker stripped in main; unit-tested |
| C6 | Copy-on-select overwriting the CLIPBOARD | Accepted: there is no other way to copy from a terminal (Ctrl+C is interrupt); this is what tmux users with `set-clipboard` get |
| C7 | Tests touching the user's real clipboard | `FLOWDECK_TEST_CLIPBOARD=1` swaps in an in-memory clipboard for E2E |
| C8 | Moving a group also moves terminals the user did not mean to move | Only items **fully** inside at drag start; items already part of a multi-selection drag are not moved twice |
| C9 | Ctrl+Shift+T is "new tab" in many apps; Ctrl+Shift+R reloads the Electron window | Text uses `Ctrl+Shift+X`; shortcuts are filtered from xterm like the existing ones |
| C11 | Draw the scrollbar from xterm.js' own scrollback | **Rejected**: the history lives in tmux (alternate screen); xterm has none |
| C12 | Bind every key in tmux's copy-mode table to "cancel and send" | **Rejected**: tmux cannot bind "any key"; leaving copy mode from main before the first keystroke covers every key and keeps tmux's mouse bindings |
| C13 | Polling the scroll position continuously | **Rejected**: read only after wheel turns and drags |
| C10 | Unbounded drawing rows | At most 1000 annotations; text ≤ 2000 chars; validated in main |

## 4. Task list

| # | Task | Done when |
|---|---|---|
| K1 | Mouse coordinate adapter for zoomed terminals | E2E: exact line copied at 80 % and 150 % |
| K2 | OSC 52 handler → `clipboard:write` (PRIMARY + CLIPBOARD); Shift+drag selection too; test clipboard seam | E2E: drag copies; OSC 52 from a program is ignored |
| K3 | `pty:paste` in main with sanitising; middle click (PRIMARY) and Ctrl+Shift+V (CLIPBOARD) | unit (sanitising) + E2E (middle click pastes) |
| K4 | Rename button in the node header and the Terminals panel | E2E |
| K5 | Annotations: shared types/schemas, migration v3, repo, core, IPC, snapshot | unit/integration (migration, validation, CRUD) |
| K6 | Group and Text node types, toolbar with draw mode and shortcuts, group drag moves contents, delete | E2E (draw, edit, move, reload, delete) |
| K8 | Scrollback: no yellow indicator, slim draggable scrollbar, config re-applied to a running server | integration (scroll commands, idempotent reload) + E2E |
| K9 | Typing after scrolling back reaches the program | E2E |
| K7 | Docs, Snyk scans, full test run, package build | all green |

## 5. Execution results

All tasks are done; results in `docs/VERIFICATION.md` (0.3.0). Found while testing and fixed:
- The toolbar **Fit** button never did anything: React Flow's queued `fitView` waits for a node
  update that never came with FlowDeck's controlled nodes. It now computes the bounds itself
  (`fitBounds`), and controlled nodes carry their measured size.
- A selected group's toolbar inherited the group's negative z-index and sat under the canvas; it
  now has its own z-index and sits inside the group's title bar.

### Known limitations
- The mouse-coordinate fix relies on an xterm.js internal (guarded, covered by E2E at three zooms).
- Copy-on-select also replaces the clipboard (there is no other way to copy from a terminal).
- Group membership is decided when a drag starts (items fully inside); groups do not nest
  automatically when created.
