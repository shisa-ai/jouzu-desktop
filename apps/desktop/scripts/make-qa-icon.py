# Usage: python scripts/make-qa-icon.py src-tauri/icons/icon.png src-tauri/icons/qa  (needs Pillow; Windows Segoe UI Bold)
# Builds the QA variant of the Jouzu icon: the normal mark with a "QA" badge.
import sys
from PIL import Image, ImageDraw, ImageFont
src, out_dir = sys.argv[1], sys.argv[2]
base = Image.open(src).convert("RGBA").resize((512, 512), Image.LANCZOS)
badge = Image.new("RGBA", base.size, (0, 0, 0, 0))
d = ImageDraw.Draw(badge)
# Bottom-right badge, large enough to read at 16 px.
box = (196, 300, 508, 508)
d.rounded_rectangle(box, radius=48, fill=(245, 158, 11, 255), outline=(255, 255, 255, 255), width=14)
font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 150)
text = "QA"
l, t, r, b = d.textbbox((0, 0), text, font=font)
cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
d.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=font, fill=(255, 255, 255, 255))
icon = Image.alpha_composite(base, badge)
icon.save(f"{out_dir}/icon.png")
for size in (32, 64, 128):
    icon.resize((size, size), Image.LANCZOS).save(f"{out_dir}/{size}x{size}.png")
icon.save(f"{out_dir}/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.resize((256, 256), Image.LANCZOS).save(f"{out_dir}/128x128@2x.png")
icon.save(f"{out_dir}/icon.icns")
