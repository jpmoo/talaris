# Fonts

The four typefaces the theme offers — Barlow Semi Condensed (the default),
Rajdhani, Saira Semi Condensed and Exo 2 — in their Latin regular and medium
weights, as woff2. Each is under the SIL Open Font License 1.1; its license
sits beside it as `<name>.LICENSE`.

They are copied from the `@fontsource/*` packages (root `devDependencies`).
To refresh them, update those packages and copy
`node_modules/@fontsource/<name>/files/<name>-latin-{400,500}-normal.woff2`
here again. `tokens.css` declares them.
