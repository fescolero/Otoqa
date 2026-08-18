# Console design

The console is built on the **Otoqa Console Design System**. This file records
how that system is expressed in this codebase, and the decisions that differ
from the system's own delivery.

## Where things live

| File | What it holds |
| --- | --- |
| `app/globals.css` | Tokens and every component class. The whole console re-skins from here. |
| `components/ui.tsx` | `Panel` `PageHeader` `Kpi` `Badge` `EmptyState` `DetailGrid` `FilterChips` + `toneFor` |
| `components/ConsoleShell.tsx` | Sidebar, nav groups, nav signals, the topbar, the access gate |
| `components/ThemeToggle.tsx` | system / light / dark, written to `<html data-theme>` |
| `components/ReasonAction.tsx` | The audited-write primitive — every mutation goes through it |
| `components/PanelBoundary.tsx` | One panel fails, the page survives |
| `app/layout.tsx` | Instrument Serif / Geist / Geist Mono via `next/font` |
| `components/DevTools.tsx` | React Grab, development only — see below |

The design system ships its components as inline-styled JSX for prototyping.
Here they are **class names against one stylesheet** instead: a panel then
costs no runtime style objects, and a token change re-skins every page at once
rather than needing a pass over 40 call sites.

## The rules worth knowing

**Warm paper, hairline structure, near-monochrome.** `#FAFAFA` canvas,
`#FAFAF8` card, `#E5E5E5` border, `#0E0E0C` ink. Never grey-blue. One accent —
Otoqa blue `#2E5CFF` — used only for links, focus rings and the active nav
plate. **Solid buttons are near-black, not blue.**

**Dark is the same product unlit, not a second one.** Only the *semantic* token
layer is redefined, so every rule below the token block is theme-agnostic and
the whole console flips from one CSS block. Two things invert rather than
darken: a solid action becomes near-white with dark text (it is still the
highest-contrast thing on the page), and a status chip becomes a low-alpha wash
of the 500-step under a lightened foreground — a solid dark-green chip on a
dark plate has nothing separating it from the plate. Add a token to `:root` and
you must add it to **both** dark selectors; there is no preprocessor here.

**Instrument Serif appears exactly twice:** page titles and KPI figures.
Everything else is Geist; machine values are Geist Mono.

**The panel is a shell holding a plate.** An 8px `#FAFAF8` card with 4px of
padding, containing a white content plate. The header lives in that 4px shell,
so `tone` tints the band without touching the content. Use `flush` when the
content is rows or a table, which carry their own gutters. There is no shadow
anywhere except on layers that float.

**Status is carried by chips, never by colour alone** and never by an emoji.
`toneFor()` maps the console's own vocabulary — `stale`, `all_failed`,
`partially_paid` — onto a tone, so the same word means the same colour on every
page.

**Machine words stay verbatim and lowercase.** `written_off` renders as
`written_off` in a mono cell because that is what the ledger and the audit trail
say. Underscores are spaced only in a human-facing status label, and the value
never changes.

**Empty copy says why it is empty.** "No data" tells an operator nothing;
`EmptyState`'s `hint` is where the reason goes.

**A list of records is a table, even when it expands.** The invoice ledger and
the unevidenced-payment list use `.record-row` — a CSS grid with fixed tracks —
rather than the flex `.audit-row` a feed uses. Flex rows look fine until the
status chips differ in width, at which point every column after the status
starts at a different x and a homogeneous list stops scanning. Grid gives
aligned columns *and* lets the expanded detail sit beside the row as a
full-width sibling, which a `<table>` cannot do cleanly. Money cells get
`.record-num` (right-aligned, tabular). Trailing chips live in `.record-notes`,
which wraps rather than clips: a row is allowed to grow, but a fact is never
hidden to keep the rhythm — so the tracks are sized for two chips on one line.

**A filter chip carries its count, or it is a guess.** `FilterChips` is the
only implementation — three hand-rolled copies had drifted, and two of them
showed no counts at all, so `void` and `written_off` looked identical to a
filter holding forty rows until you clicked each in turn. A count of zero dims
the chip rather than removing it: "there are none" is an answer, and a missing
chip is not. Where the list query caps below the counted total, the panel
footer says so — a chip promising 240 rows over a list showing 100 is worse
than no chip.

**A derived state gets a filter too.** The board badges rows `overdue`, which
is not a stored status — it is an open invoice past its due date with a
balance. Without a chip for it, the one question a receivables board exists to
answer could only be reached by clicking `issued`, then `sent`, then reading
dates. `listInvoices({ overdueOnly: true })` computes it server-side so the
chip count and the filtered list cannot disagree.

**Caveats are part of the copy.** Panel `footer` is for them: "counts cap at
500", "metered usage only", "showing the first 200 matches". A number whose
staleness or cap is unstated cannot be acted on.

## Decisions that differ from the system as shipped

- **Fonts are self-hosted, not `@import`ed from Google.** `next/font` fetches
  them at build time and serves them from our origin. The console has to work
  during an incident, and its page views should not be visible to a third
  party.
- **Icons are `lucide-react`,** the tenant app's set. The design system flagged
  adding icons to the console for review; the sidebar is where they earn their
  place, because an operator navigates it by shape before reading it.
- **No `Sheet`, no `Toast`, no `Tabs`.** The system offers a right-side sheet;
  nothing here yet needs one. Adding it before a screen requires it would be
  inventing a pattern to maintain.

## Pointing at an element

`react-grab` is mounted in development. Hover any element in the console, press
**⌘C / Ctrl+C**, and the clipboard gets the element plus its component and
source location:

```
[<span class="chip chip-warn">paid 50d late</span> in InvoiceRow
 (at components/InvoicesBoard.tsx:341:11)]
```

Paste that at an agent instead of describing which chip you mean. Two rules
about it:

- **Development only, and not merely by preference.** It binds ⌘C, and staff
  copy org ids, invoice numbers and bank references out of this console
  constantly — a selection overlay owning the copy key would break the
  console's most-used interaction. It also walks the React tree and reads
  source paths, which is fine on a laptop and wrong on a page rendering
  customer billing data. The guard is statically false in a production build,
  so the import is *eliminated*, not skipped: `grep -r "react-grab\|bippy"
  .next/static` after a build returns nothing, and that is the check to re-run
  if this ever changes.
- **Imported from `node_modules`, not the CDN `<script>` the README suggests.**
  The rule that made the fonts self-hosted applies harder to executable
  third-party code with full DOM access.

## The topbar

52px above the content column, carrying the two facts that are true of the
whole session rather than of any one page:

- **Which deployment you are about to write to.** The dev and production
  consoles are visually identical and every control here writes money or ends
  someone's shift. Derived from `NEXT_PUBLIC_CONVEX_URL`; override the label
  with `NEXT_PUBLIC_CONSOLE_ENV`.
- **Whether alerting is live.** Derived, never decorative: the evaluator must
  be running *and* a delivery channel must be configured. Alerts that are
  recorded and never delivered are not alerting, and the chip says so.

Plus the bell (open-alert count, links to Overview), the theme toggle, and sign
out. Sign out lives here rather than in the sidebar footer — it is a session
action, and it was previously a bare blue link sitting under the staff email
where it read as part of the address.

## Not done

- **Mobile.** The shell is a fixed 232px sidebar beside a content column; below
  ~900px it does not collapse. Nobody has asked to run the console from a
  phone, and the tables would be unusable there regardless.
- **A command palette.** With eight pages and nav counts, the fastest path to
  a surface is already one click. Worth revisiting if the page count grows.
- **`prefers-reduced-motion`** zeroes the durations, but nothing in the console
  animates yet beyond control transitions.
- **The bell is a link, not an inbox.** It shows the open-alert count and goes
  to Overview. A real notification store would be a feature, not a chrome
  detail, and Overview already is the list.
