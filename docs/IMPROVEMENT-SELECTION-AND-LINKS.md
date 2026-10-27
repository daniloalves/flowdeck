# Improvement: the last selected character, and Ctrl+click on links

Requested on 2026-10-27:
1. "Selecting and pasting works well; the only detail is that the last selected character is not
   pasted."
2. "Could links open from tmux? In Ubuntu's terminal I held Ctrl and clicked the link and it opened."

## 1. Understanding

| Question | Finding |
|---|---|
| Why is the last character lost? | Reproduced with an E2E test: dragging from `a` to `j` over `abcdefghij` copies `abcdefghi`. tmux draws the selection, and FlowDeck's tmux.conf did not set `mode-keys`, so tmux used **emacs** copy-mode keys. With emacs keys the end of a selection is **exclusive**: the character under the pointer where the drag ends is left out. Verified on tmux 3.4 with copy-mode commands: emacs → `abcdefghi`, vi → `abcdefghij` |
| Side effect of vi keys | With vi keys, a drag that goes past the end of a line also selects its line break (`LINE8\n`), like xterm and GNOME Terminal. Pasting that into a shell without bracketed paste would run the command |
| Does anything use copy-mode keys? | No. Typing leaves copy mode before the key is sent (0.3.0), and the mouse bindings are the same in both tables |
| Links today | xterm.js only finds links with an addon (`@xterm/addon-web-links`, official, the release that matches xterm 6.0.0) or through OSC 8 hyperlinks with a `linkHandler`. Neither was set up. tmux 3.4 forwards OSC 8 only when the outer terminal has the `hyperlinks` feature |
| Can the renderer open a URL? | No: it is sandboxed, and `window.open` is denied for every window. Opening needs main (`shell.openExternal`, which runs `xdg-open` with the URL as an argument) |
| Is opening a browser an outbound request by FlowDeck? | No. The user's browser makes the request after an explicit Ctrl+click. FlowDeck itself still opens no connections |
| Long URLs | A URL longer than the terminal wraps. tmux keeps the wrap, so xterm sees one link over two rows (verified in E2E) |

## 2. Design

- **Selection:** a drag copies everything from the character where it starts to the character where
  it ends, in both directions and at any zoom. A selection that runs past the end of a line does not
  carry the line break into the clipboard, so a paste never runs a command by itself.
- **Links (GNOME Terminal convention):**
  - **Ctrl+click** opens a link in the default browser (Cmd+click on macOS).
  - A plain click stays the terminal's: it clicks, selects or focuses as before.
  - Hovering a link shows its real target and "Ctrl+click to open". For an OSC 8 link the target
    can differ from the visible text.
  - Two kinds of links work: URLs printed as text, and OSC 8 hyperlinks from programs.
  - **Only `http(s)` links open.** `file:`, `javascript:` and schemes that start other
    applications (`vscode:`, `ssh:`…) are ignored, as are URLs with a user name or password
    (`https://bank.example@evil.example` hides the real host).

## 3. Architecture

| Layer | Change |
|---|---|
| `resources/tmux.conf` | `set -g mode-keys vi`; the `hyperlinks` feature in `terminal-features[10]`. Both are applied to an already running server on start (`source-file`) |
| `main/clipboard.ts` | `copiedText()` drops one trailing line break; `clipboard:write` uses it |
| `packages/shared` | Send channel `link:open { url }` with `linkOpenSchema` (≤ `LIMITS.linkChars` = 8192; login URLs are long) |
| `main/links.ts` (new) | `webUrl()` checks the URL. `systemLinks(shell)` opens it. `memoryLinks()` records links instead, for tests (`FLOWDECK_TEST_LINKS=1`). `rateLimited()` allows at most one open per 500 ms |
| `main/ipc.ts` | `link:open` → `webUrl` → the opener |
| `renderer/terminal/links.ts` (new) | Loads `WebLinksAddon` and sets `linkHandler` (OSC 8, `allowNonHttpProtocols: false`). Both call one `activate` that needs Ctrl or Cmd and sends `link:open`. Hover sets the terminal's tooltip |
| Dependency | `@xterm/addon-web-links@^0.12.0`: official, no dependencies of its own; Snyk package health "Healthy", no known vulnerabilities |

### Alternatives considered

| # | Alternative | Decision |
|---|---|---|
| S1 | Keep emacs keys and bind the mouse drag to a custom copy command | **Rejected**: tmux has no option for an inclusive end in emacs mode |
| S2 | Leave the trailing line break (classic xterm behaviour) | **Rejected**: a paste could run a command in a shell without bracketed paste |
| L1 | Write our own URL regex link provider | **Rejected**: the official addon already handles wrapped lines and URL edge cases |
| L2 | Open links on a plain click | **Rejected**: a click must stay a terminal click (selection, focus, programs that use the mouse) |
| L3 | Let the renderer call `window.open` | **Rejected**: the renderer never opens anything; main checks the URL |

## 4. Execution plan

| # | Task | Done when |
|---|---|---|
| M1 | E2E tests that reproduce the missing last character | they fail before the fix (verified: `abcdefghi`) |
| M2 | `mode-keys vi`, `copiedText` | E2E left-to-right and right-to-left at 100 % and 80 %; integration on real tmux |
| M3 | `link:open` channel, `main/links.ts`, the renderer link handlers, tmux `hyperlinks` | unit (`webUrl`, rate limit) and E2E (Ctrl+click opens, a plain click does not, OSC 8, `file:` ignored, a wrapped URL opens whole) |
| M4 | Docs, Snyk Code and SCA, full test run | all green |

## 5. Implementation results

All done; results in `docs/VERIFICATION.md` (0.4.0).

Found while testing:
- The old "selects its own line" E2E caught the trailing line break that vi keys add when a drag
  goes past the end of a line. That led to `copiedText`.
- In E2E every mouse move takes about 1 s, because Playwright waits for each input event and the
  test window is never shown. The same happens with the links addon disabled, so it is a test
  harness cost, not a product one. Drags in the new tests use fewer steps.

### Known limitations
- tmux's internal buffer still holds the trailing line break. FlowDeck always pastes from the
  system clipboard and PRIMARY, so this is not visible to the user.
- Plain-text detection finds `http(s)://` URLs only; bare `example.com` and file paths are not
  links.
