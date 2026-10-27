# Improvement: canvas texts always stay in front

Requested on 2026-10-26: "When I place a text over a terminal, the text goes behind the terminal and
disappears. A text should always stay in front of everything and never disappear unless deleted."

## 1. Understanding

| Question | Finding |
|---|---|
| When does a text go behind? | Reproduced with an E2E probe: a text over a terminal is in front until the terminal is **selected** (header click, or a click in it, which selects and focuses it). The text then sits under the terminal and cannot be seen or clicked |
| Why? | React Flow 12 (`zIndexMode: 'basic'`) gives every node `zIndex + 1000` while it is selected. Texts and terminals both have z-index 0, so the selected terminal (1000) covers the text (0). Edges that touch a selected node are lifted too (`elevateEdgesOnSelect` is on by default): up to 2000 |
| What does "in front of everything" mean here? | In front of terminals (selected or not), edges and groups. The text's own toolbar and the editing box stay usable. App chrome (toolbar, panels, dialogs, draw layer) is outside the canvas and stays above it |
| What stays the same? | Groups stay behind everything (−2000). Texts are still moved, resized, edited and deleted the same way. Deleting is still the only way to remove one |

## 2. Design

- A text is drawn in front of every terminal, edge and group, whatever is selected or focused.
- Between texts, a selected text comes in front of the other texts (React Flow's +1000 still applies).
- Where a text covers a terminal, clicks on the text's box go to the text (select, drag, double-click
  to edit). The rest of the terminal works as before. To reach what is under a text, move the text.

## 3. Architecture

- Renderer only: `canvas/Canvas.tsx` gives text nodes a fixed `zIndex` (`TEXT_Z = 3000`), the mirror of
  `GROUP_Z = −2000`. Resulting order, bottom to top:

  | Layer | z-index |
  |---|---|
  | Group / selected group | −2000 / −1000 |
  | Terminal / selected terminal | 0 / 1000 |
  | Edge / edge lifted by a selection | 0 / ≤ 2000 |
  | Text / selected text | 3000 / 4000 |
  | Annotation toolbar | 5000 |

- No change to shared types, IPC, the database or main. Nothing is stored: the layer is set when the
  canvas is drawn, so existing texts are fixed without a migration.

### Alternatives considered

| # | Alternative | Decision |
|---|---|---|
| T1 | `elevateNodesOnSelect={false}` | **Rejected**: a selected terminal would no longer come in front of overlapping terminals |
| T2 | Draw texts in a separate overlay outside React Flow | **Rejected**: duplicates zoom/pan, drag, resize and selection handling for a one-line problem |
| T3 | Let clicks on empty parts of a text box pass through to the terminal | **Rejected for now**: the box would stop being draggable where it shows its frame; can be revisited if covering a terminal turns out to be annoying |
| T4 | Store a per-annotation layer ("bring to front"/"send to back") | Not needed for this request; texts are always in front by design |

## 4. Execution plan

| # | Task | Done when |
|---|---|---|
| L1 | E2E test: a text over a terminal stays topmost while the terminal is selected and focused, and can still be edited | test fails before the fix (verified) and passes after |
| L2 | `TEXT_Z` in `Canvas.tsx` | L1 passes |
| L3 | Docs: this file, the layering note in `FEATURE-CANVAS-AND-CLIPBOARD.md`, `CHANGELOG.md`, `VERIFICATION.md` | written |
| L4 | `pnpm typecheck && pnpm test && pnpm e2e`, Snyk Code scan | all green, no new findings |

## 5. Implementation results

Recorded in `docs/VERIFICATION.md` (0.4.0).
