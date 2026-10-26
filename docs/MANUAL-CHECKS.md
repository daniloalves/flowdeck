# Manual Checks

Automated tests cover the pipeline with real tmux, the real hook relay and a fake `claude`, plus a
token-free smoke test against the real CLI. These acceptance items need a person and real accounts.

| # | Check | How |
|---|---|---|
| 1 | Two real accounts | Register `~/.claude` and `~/.claude-work`, open a login node for each, run `/login`, then `/status` in each node shows the right e-mail |
| 2 | Notifications | Ask a node for a long task, switch to another window, a "finished" notification appears; a permission prompt turns the node orange and notifies |
| 3 | Usage accuracy | Compare the 5 h / 7 d numbers on a badge with `npx ccusage blocks --active` / `npx ccusage daily` for the same config dir (input + output tokens; target < 5 % difference) |
| 4 | Agents talking | Connect "leader" → "reviewer", ask the leader to use `send_to` while the reviewer is busy; the message arrives after the reviewer finishes and shows in **Messages** |
| 5 | Real reboot | Four nodes on two accounts, each with a conversation; reboot; open FlowDeck; every node is back in place and `/status` / history show the same conversation |
| 6 | Packaged install | `sudo apt install ./flowdeck-0.1.0-amd64.deb`, launch from the menu (minimal `PATH`), create a Claude node: `claude` is found through the login-shell `PATH` |
| 7 | Network silence | Run FlowDeck under OpenSnitch (or `sudo ss -tnp` while using it): FlowDeck itself opens no outbound connections (Claude Code processes inside nodes do, as expected) |
| 8 | Codex node | Register `~/.codex`, create a Codex node, choose "Trust all and continue" when Codex asks about hooks, send a prompt: the node turns blue then green; an approval request turns it orange |
| 9 | Kiro node | `kiro-cli login` once, create a Kiro node, send a long prompt: the bullet turns blue while it prints and green when it settles; a message from a connected Claude node is typed into it |
| 10 | Terminals panel | Open **Terminals**: rows sorted with "needs you" first, counts and legend match the canvas; Go to centres the node; Ctrl+Shift+N / Ctrl+Shift+D work even while a terminal has focus |
| 11 | Clipboard with other apps | Select text in a node, middle-click in gedit/Firefox: it pastes; Ctrl+V there pastes it too. Select text in another app, middle-click in a node: it is typed at the prompt (not executed) |
| 12 | Scrollback | Scroll back with the wheel in a busy Claude node: a slim grey scrollbar appears (no yellow `[n/m]`), dragging it scrolls, typing a letter returns to the prompt with the letter typed |
| 13 | Groups and texts | Group two terminals (select one, Ctrl+Shift+G), name it, drag the group: both terminals follow; add a text, restart FlowDeck: everything is where you left it |

Known limitations to keep in mind while checking:
- Kiro has no "needs you" state; Codex stays "Starting" until its hooks are trusted and it gets a first prompt.
- Pressing `Esc` to interrupt Claude does not fire `Stop`; the node shows "working" until Claude's idle reminder (~60 s).
