# Console design

The console is built on the **Otoqa Console Design System**. This file records
how that system is expressed in this codebase, and the decisions that differ
from the system's own delivery.

## Where things live

| File | What it holds |
| --- | --- |
| `app/globals.css` | Tokens and every component class. The whole console re-skins from here. |
| `components/ui.tsx` | `Panel` `PageHeader` `Kpi` `Badge` `EmptyState` `DetailGrid` `FilterChips` + `toneFor` |
| `components/ConsoleShell.tsx` | Sidebar, nav groups, nav signals, the access gate |
| `components/ReasonAction.tsx` | The audited-write primitive — every mutation goes through it |
| `components/PanelBoundary.tsx` | One panel fails, the page survives |
| `app/layout.tsx` | Instrument Serif / Geist / Geist Mono via `next/font` |

The design system ships its components as inline-styled JSX for prototyping.
Here they are **class names against one stylesheet** instead: a panel then
costs no runtime style objects, and a token change re-skins every page at once
rather than needing a pass over 40 call sites.

## The rules worth knowing

**Warm paper, hairline structure, near-monochrome.** `#FAFAFA` canvas,
`#FAFAF8` card, `#E5E5E5` border, `#0E0E0C` ink. Never grey-blue. One accent —
Otoqa blue `#2E5CFF` — used only for links, focus rings and the active nav
plate. **Solid buttons are near-black, not blue.**

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

## Not done

- **Dark mode.** The system defines one palette, and inventing a dark ramp for
  it would be guesswork. If staff want it, the tokens are all in `:root` and a
  `prefers-color-scheme` block is the whole job — but the ramps need designing,
  not deriving.
- **Mobile.** The shell is a fixed 232px sidebar beside a content column; below
  ~900px it does not collapse. Nobody has asked to run the console from a
  phone, and the tables would be unusable there regardless.
- **A command palette.** With eight pages and nav counts, the fastest path to
  a surface is already one click. Worth revisiting if the page count grows.
- **`prefers-reduced-motion`** zeroes the durations, but nothing in the console
  animates yet beyond control transitions.
