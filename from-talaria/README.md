# From Talaria

**Only what is still to be adopted lives here.** Anything retired, or already
taken into Talaris, is deleted rather than kept — its history is in
`jpmoo/hermesnotes`, where it came from, under `talaria/linux/`.

What is left: `canvas/`, copied from `talaria/linux/canvas/` at commit
`6f49e26` on 2026-10-23. A fork of Hermes' `CanvasView`, with bend geometry,
snapping, regions, marquee and shapes already solved; React and Lucide only.
`api.ts` and `document.ts` are the only files that know Talaria's vocabulary.

Already removed from it, because Talaris does not have them: `CanvasChat`
(Morgan is the one chat), and `BlockCard` and `QueryBuilder` (Hermes blocks
and collections are the Hermes plugin's to draw). `main.tsx` and
`CanvasView.tsx` still import them; cutting those imports is the first step of
adopting the canvas, and this folder goes when that is done.

Talaria's code is MIT-licensed there and stays so there. The owner wrote it, so
it is relicensed here under GPL-3.0-only when adopted.
