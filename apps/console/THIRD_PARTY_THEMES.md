# Third-party theme families

The ContextCake console can wear a handful of well-known editor and terminal
palettes (Settings → Appearance → Theme). Each family is a small CSS file under
`src/themes/` that maps the upstream palette's named colors onto the console's
thirteen primitive tokens per mode; everything else the console draws is
derived from those in `src/themes/_derived.css`. This file is the notice for
those palettes: whose they are, where the values came from, and under what
terms. The header comment of every family file repeats its own entry.

Every family shipped in this release is MIT-licensed. Verified 2026-08-18
against each project's LICENSE file (or, for Gruvbox, its README and
`package.json` license declaration — the repository carries no LICENSE file).
The palettes are used as color values only; no upstream code is included.

| Family (file) | Author / organization | Source | License |
|---|---|---|---|
| Solarized (`solarized.css`) | Ethan Schoonover | https://ethanschoonover.com/solarized/ · https://github.com/altercation/solarized | MIT — © 2011 Ethan Schoonover |
| Catppuccin (`catppuccin.css`) — Latte / Mocha | The Catppuccin organization | https://catppuccin.com/palette/ · https://github.com/catppuccin/palette (`palette.json`) | MIT |
| Gruvbox (`gruvbox.css`) | Pavel Pertsev (morhetz) | https://github.com/morhetz/gruvbox (`colors/gruvbox.vim`) | MIT/X11, as declared in the README and `package.json` |
| Tokyo Night (`tokyo-night.css`) — Light / Night | enkia | https://github.com/enkia/tokyo-night-vscode-theme (`themes/*.json`) | MIT (`LICENSE.txt`) |
| Rosé Pine (`rose-pine.css`) — Dawn / Main | Rosé Pine contributors | https://rosepinetheme.com/palette/ · https://github.com/rose-pine/palette | MIT |
| One (`one.css`) — One Light / One Dark | GitHub (Atom) | https://github.com/atom/one-light-syntax · https://github.com/atom/one-dark-syntax · https://github.com/atom/one-light-ui · https://github.com/atom/one-dark-ui | MIT (repositories archived) |
| GitHub (`github.css`) — Light / Dark | GitHub (Primer) | https://github.com/primer/primitives — `@primer/primitives` 11.10.0, `dist/css/functional/themes/{light,dark}.css` | MIT |

Tokyo Night is deliberately the **VS Code theme by enkia**, not the popular
`tokyonight.nvim` port by folke — that port is Apache-2.0, and its "Day"
values differ from enkia's "Light". ContextCake's family therefore uses enkia's
values throughout, and its light half is named "Light", as upstream names it.

## How a palette becomes a family

Each family declares, per mode, exactly these primitives (the list is
`PRIMITIVES` in `src/themes/gates.ts`, enforced by `src/themes/tokens.test.ts`):

| Token | Role | Typical upstream source |
|---|---|---|
| `--cc-page` | main background | editor / base background |
| `--cc-surface` | panels, groups | secondary / chrome background |
| `--cc-raised` | cards, popovers, pressed controls | the lightest tone (light) or a lifted tone (dark) |
| `--cc-header-bg` | sidebar + toolbar | sidebar / chrome background — always opaque, so macOS vibrancy is disabled for every family but ContextCake |
| `--cc-canvas-bg` | the pan/zoom canvas | main background (light) or the darkest tone (dark) |
| `--cc-ink` / `--cc-body` / `--cc-caption` / `--cc-faint` | the four text tones | primary text, body text, secondary text, comments |
| `--cc-layer-company` | company layer — always the palette's **blue** | |
| `--cc-layer-team` | team layer — always the palette's **green / teal** | |
| `--cc-layer-personal` | personal layer — always the palette's **yellow / amber** | |
| `--cc-conflict` | conflicts, danger — always the palette's **orange / red** | |

The hue roles are fixed on purpose: a chip's color says which layer a piece of
context came from, and that must read the same in every family. Where a
palette offers fewer text tones than the console has roles (Rosé Pine, GitHub
Primer), ink and body share the primary text tone rather than a caption being
promoted to body. Where a palette's own body tone misses the console's 4.5:1
floor (Solarized `base00`), the next tone up is used and the notes in the file
say so. Every family, in both modes, has to clear `src/themes/contrast.test.ts`
— there is no per-family exception list; a mapping that cannot pass is changed,
never waived. A family file may additionally override a derived token where
the palette defines that role itself (Rosé Pine's highlight tones and Primer's
border tokens replace the derived `--cc-line*`).

## Candidates not shipped

v1 ships only families with an official light **and** dark variant. Listed
here so the next pass does not re-research them:

- **Nord** (nordtheme, MIT) — no official light variant.
- **Dracula** (MIT) — the light variant, Alucard, ships with Dracula PRO;
  verify whether a free, official Alucard palette exists before adding.
- **Monokai** — dark only; Monokai Pro (which has a light "Light" filter) is
  commercial.
- **Everforest** and **Ayu** — both have official light and dark variants
  under MIT; good v1.1 candidates.
