# Brand

The Rask mark is a geometric R sheared 12 degrees, with bars trailing the stem.
The lean and the wake are the whole idea: *rask* is Norwegian for fast, and the
product is a keyboard-first client for people who find the official one slow.

Two cuts, because the mark does not survive being shrunk without help.

| File | Use |
|------|-----|
| `rask-mark.svg` | The mark. Two wake bars. Anything 24px and up. |
| `rask-mark-compact.svg` | One wake bar, heavier stroke. 16–24px, where the two bars merge into a smear. |
| `favicon.svg` | The compact cut with explicit colours, flipped by `prefers-color-scheme`. |

Both SVGs paint with `currentColor`, so set `color` on the parent rather than
editing the file. The app inlines both cuts in
`apps/web/src/components/Logo.tsx` (`Logo` is the full mark, on the sign-in
page; `LogoCompact` is the small one, in the sidebar). Those copies and the SVGs
here have to be changed together.

`apps/web/public/` holds the deployed copies of `favicon.svg` and the Apple
touch icon. The touch icon ships opaque on `#0F0F0F` because iOS composites a
transparent one over black. `apps/site/public/` holds the same two plus
`og.png`, the 1200x630 card link previews show.

That card is the mark alone, on the app background. The title and description
ride in the page's meta tags, so baking them into the image would be a second
copy to keep in step — and text rasterised on one machine picks up that
machine's fonts, which on Linux are not the ones the page uses.

## Regenerating the PNGs

```bash
python3 docs/brand/export_png.py
```

Rasterises through headless Chrome rather than cairosvg, so there is nothing to
install. Sizes and colours are the `JOBS` list at the top of the script.
