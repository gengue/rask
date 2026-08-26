# Themes

System by default, with light and dark available. The button in the sidebar
footer cycles the three; `⌘K` jumps straight to one. "System" is stored as
the *absence* of `localStorage["rask.theme"]`, so a fresh profile follows
`prefers-color-scheme` with nothing written. An inline script in `index.html`
applies the class before the stylesheet loads, because a theme read after first
paint is a white flash on a dark screen.

Every text colour clears WCAG AA in both themes — 4.5:1 for body text, 3:1 for
glyphs — measured rather than eyeballed:

```bash
bun run --cwd apps/web contrast
```

It parses the tokens out of `apps/web/src/theme.css`, prints all 66 foreground/surface
pairs, and exits non-zero on anything below AA. Run it before changing a colour
token; `apps/web/test/contrast.test.ts` runs the same audit so CI does too.

The palette sits in its own file rather than in `styles.css` because the
landing page in `apps/site` paints with the same names. A second copy would
drift, and the annotated ratios would drift with it.
