"""Rasterise the Rask mark to PNG at the sizes an app actually needs.

Uses headless Chrome rather than cairosvg so there is nothing to pip install.

    python3 docs/brand/export_png.py
"""
import pathlib, shutil, subprocess, tempfile

# Whichever of these exists. It was the macOS path alone, which meant the
# script could not run on the Linux box half this project is developed on.
CHROME = next(
    (c for c in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ) if c and pathlib.Path(c).exists()),
    None,
)
if CHROME is None:
    raise SystemExit("No Chrome or Chromium found. Install one, or set CHROME by hand.")

brand = pathlib.Path(__file__).resolve().parent
out = brand / "png"
out.mkdir(exist_ok=True)

# (source svg, size, colour, filename, background)
# iOS composites apple-touch-icon over black, so that one ships opaque.
JOBS = [
    *[("rask-mark.svg", n, "#0F0F0F", f"rask-mark-{n}.png", "transparent") for n in (1024, 512, 256, 128, 64)],
    *[("rask-mark.svg", n, "#FAFAFA", f"rask-mark-{n}-light.png", "transparent") for n in (1024, 512, 256)],
    *[("rask-mark-compact.svg", n, "#0F0F0F", f"rask-mark-compact-{n}.png", "transparent") for n in (48, 32, 24, 16)],
    ("rask-mark-compact.svg", 180, "#FAFAFA", "apple-touch-icon-180.png", "#0F0F0F"),
]

for src, size, colour, name, bg in JOBS:
    svg = (brand / src).read_text()
    html = (f'<!doctype html><meta charset=utf-8>'
            f'<style>html,body{{margin:0;background:{bg}}}'
            f'svg{{display:block;width:{size}px;height:{size}px;color:{colour}}}</style>{svg}')
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        page = f.name
    subprocess.run([
        CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
        "--default-background-color=00000000",
        f"--window-size={size},{size}",
        f"--screenshot={out / name}", f"file://{page}",
    ], capture_output=True)
    pathlib.Path(page).unlink()
    print(f"{name:34} {(out / name).stat().st_size:>8} bytes")


# The Open Graph card for getrask.com. 1200x630 is what the scrapers crop to,
# and the mark alone is deliberate: the title and description ride in the meta
# tags, so repeating them here as baked pixels would only be a second copy to
# keep in step — and text rasterised on one machine picks up that machine's
# fonts.
OG = ("rask-mark.svg", 1200, 630, 300, "#F7F8F8", "#060708", "og.png")

src, width, height, mark, colour, bg, name = OG
svg = (brand / src).read_text()
html = (f'<!doctype html><meta charset=utf-8>'
        f'<style>html,body{{margin:0;height:100%;background:{bg};'
        f'display:flex;align-items:center;justify-content:center}}'
        f'svg{{display:block;width:{mark}px;height:{mark}px;color:{colour}}}</style>{svg}')
with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
    f.write(html)
    page = f.name
subprocess.run([
    CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
    f"--window-size={width},{height}",
    f"--screenshot={out / name}", f"file://{page}",
], capture_output=True)
pathlib.Path(page).unlink()
print(f"{name:34} {(out / name).stat().st_size:>8} bytes")
