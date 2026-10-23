# Fonts

The four typefaces the theme offers — Barlow Semi Condensed (the default),
Rajdhani, Saira Semi Condensed and Exo 2 — in their Latin regular and medium
weights, as woff2. Each is under the SIL Open Font License 1.1; its license
sits beside it as `<name>.LICENSE`.

They are copied from the `@fontsource/*` packages (root `devDependencies`).
To refresh them, update those packages and copy
`node_modules/@fontsource/<name>/files/<name>-latin-{400,500}-normal.woff2`
here again. `tokens.css` declares them.

## Icons

`tabler-icons-outline.woff2` is the Tabler Icons webfont (MIT; its license is
`tabler-icons-LICENSE.txt`), from `@tabler/icons-webfont` 3.31.0. Morgan's
conversation page names its icons in Tabler's words, so it wears this font;
`morgan/tabler.json` maps each name to its codepoint, taken from the package's
`tabler-icons-outline.min.css`.
