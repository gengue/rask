"""Rasterise the Rask mark to PNG at the sizes an app actually needs.

Uses headless Chrome rather than cairosvg so there is nothing to pip install.

    python3 docs/brand/export_png.py
"""
import pathlib, subprocess, tempfile

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
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
