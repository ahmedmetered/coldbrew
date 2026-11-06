# Design: Coldbrew

A slow-brewed workbench. Calm and steady, coffee colours, nothing urgent unless it needs your approval. Operate mode: a daily tool, so scanability and consistency come before expression.

## Color

Two themes, same hues. Dark (espresso) after dark or by choice; light (crema) by day. Theme follows the system, with an Auto / Light / Dark switch.

| Token | Dark (espresso) | Light (crema) | Use |
|---|---|---|---|
| `--bg` | `#1B1410` | `#F5EEE4` | page |
| `--rail` | `#150F0C` | `#EBE1D3` | navigation rail |
| `--panel` / `--panel-2` | `#251B15` / `#2D2119` | `#FFFBF5` / `#F8F0E5` | cards, rows, inputs on hover |
| `--line` / `--line-2` | `#3A2C22` / `#4D3A2D` | `#E1D4C2` / `#CDBBA3` | borders |
| `--ink` / `--ink-2` / `--ink-3` | `#F1E7DA` / `#C2B09C` / `#A08E7B` | `#2B1D14` / `#5E4A3B` / `#7A6655` | text, secondary, tertiary |
| `--accent` | `#D49A5A` caramel | `#8A531F` roasted caramel | the one action colour |
| `--good` | `#8DB38B` sage | `#4F7A4D` | replies, success |
| `--info` | `#74AEAD` steam | `#3E7A7B` | information, email channel |
| `--bad` | `#D9786A` | `#A8473A` | do-not-contact, errors only |
| `--warn` | `#D9AE55` | `#9A6B12` | contacted, needs a look |

Chart ramp `--c1` to `--c6` runs from ink through caramel to crema, with sage and steam as the two cool marks. No gradients.

## Typography

Schibsted Grotesk (self-hosted, `public/fonts/schibsted.woff2`), weights 400 to 750. Tabular numerals only where figures line up: KPIs, tables, charts, tags. h1 26px, h2 17px, body 15px, small 12.5px.

## Layout

A 232px left rail (wordmark, five destinations, campaign picker, theme and sign out) beside a main column capped at 1320px. Below 860px the rail becomes a top bar. Figures first (six KPIs), then charts in two and three column grids. The prospect detail opens as a right drawer so the list keeps its place.

## Components

- **Buttons:** 8px radius, one filled primary per view (caramel), ghost for quiet actions, danger as text with a soft fill on hover.
- **Tags:** pills for stage and channel; tone carries meaning (good = replied, info = email, warn = contacted, bad = do not contact).
- **Bars and columns:** direct value labels beside every mark, never colour alone; rate bars show `replied/sent`.
- **Lint list:** one line per issue with a symbol (x, !, check) so state is not colour-only.
- **Dialogs:** in-page modal and drawer, never `alert`, `confirm` or `prompt`.

## Motion

One authored moment: cards and figures rise in with a short stagger on first paint (`fadeup`, 500ms, exponential ease-out), drawers slide in 300ms, bar fills grow 900ms. All of it stops under `prefers-reduced-motion`.

## Accessibility

Body text 4.5:1 or better in both themes (light accent darkened to `#8A531F` for this). Focus rings in the accent colour. Charts carry an `aria-label` with their numbers and every value is printed as text. Lists and dialogs work from the keyboard (Enter opens a row, Escape closes the drawer and dialogs).
