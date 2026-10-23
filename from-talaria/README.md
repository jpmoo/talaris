# From Talaria

Copied, unedited, from `jpmoo/hermesnotes` at commit `6f49e26`
(`talaria/linux/`), on 2026-10-23. Nothing here runs as it stands: each piece
still expects Talaria's daemon, its `talaria-app://` scheme, or Hermes. It is
here to be taken from — move a piece out of this folder as it is adopted, and
change it there.

Talaria's history for any of these lives in that repository, along with the
reasoning written beside them in `talaria/linux/CLAUDE.md`, which is worth
reading before changing any of them. The "things that cost an hour" there were
paid for once.

| here | was | why it came |
|---|---|---|
| `canvas/` | `talaria/linux/canvas/` | The canvas: a fork of Hermes' `CanvasView` with bend geometry, snapping, regions, marquee and shapes solved. No dependencies on the monorepo — React and Lucide only. `api.ts` and `document.ts` are the only files that know Talaria's vocabulary; `BlockCard`, `QueryBuilder` and `CanvasChat` are Hermes- and chat-specific and are expected to go or become plugin-provided. |
| `ui/writing.html`, `richtext.js`, `calc.js`, `markdown.js` | `talaria/linux/shell/ui/` | The writing surface: Markdown files, Calca-style arithmetic, a serializer that round-trips byte-identically. Already had no connection to Hermes. |
| `ui/notefield.js`, `mentions.js`, `api.js`, `icons.js`, `panel.css` | the same | What the writing surface and canvas notes import. `mentions.js` is Hermes' `@`/`#` pickers — plugin material. |
| `shell/scheme.py`, `webprofile.py` | `talaria/linux/shell/` | A web view that talks to a daemon over a Unix socket with no port open, and the one named profile every view must share. The approach carries; the paths will not. |
| `spikes/` | `talaria/linux/spikes/` | The layer-shell spike. Its findings are in `../DESIGN.md`. |

Talaria's code is MIT-licensed there and stays so there. The owner wrote it,
so these copies are relicensed here under Talaris's GPL-3.0-only — but anyone
can still take the originals from `jpmoo/hermesnotes` under MIT. Add the SPDX
header from `CONTRIBUTING.md` to a piece when it moves out of this folder.
