"""Regenerate desktop icons from public/icon.svg (requires ImageMagick and Pillow)."""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image


root = Path(__file__).resolve().parents[1]
icons = root / "src-tauri" / "icons"
with tempfile.TemporaryDirectory() as temporary:
    raster = Path(temporary) / "icon.png"
    subprocess.run(
        ["convert", "-background", "none", "-density", "768",
         str(root / "public" / "icon.svg"), "-resize", "1024x1024", str(raster)],
        check=True,
    )
    with Image.open(raster) as source:
        image = source.convert("RGBA")
    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (512, "icon.png")):
        image.resize((size, size), Image.Resampling.LANCZOS).save(icons / name)
    image.save(icons / "icon.ico", sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
    image.save(icons / "icon.icns")
