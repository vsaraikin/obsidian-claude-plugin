"""Renders assets/social-preview.png (1280x640) for GitHub's social preview setting."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 640
BG, INK, MUTED, ACCENT = (250, 248, 245), (28, 28, 30), (110, 110, 115), (217, 119, 87)
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def font(size, weight="Regular"):
    f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
    f.set_variation_by_name(weight)
    return f


def icon(x, y, s):
    """Same geometry as assets/icon.svg, on its 128 grid."""
    k = s / 128
    d.rounded_rectangle([x, y, x + s, y + s], radius=28 * k, fill=ACCENT)
    ox, oy, lw = x + 14 * k, y + 14 * k, max(2, round(8 * k))
    d.rounded_rectangle([ox + 12 * k, oy + 14 * k, ox + 88 * k, oy + 86 * k], radius=12 * k, outline="white", width=lw)
    d.line([ox + 64 * k, oy + 14 * k, ox + 64 * k, oy + 86 * k], fill="white", width=lw)
    for y0, x1 in [(36, 50), (50, 50), (64, 40)]:
        d.line([ox + 26 * k, oy + y0 * k, ox + x1 * k, oy + y0 * k], fill="white", width=lw)
    for a, b in [(34, 44), (56, 66)]:
        d.line([ox + 76 * k, oy + a * k, ox + 76 * k, oy + b * k], fill="white", width=max(2, round(7 * k)))


icon(72, 150, 92)
d.text((72, 270), "Agent Sidebar", font=font(64, "Bold"), fill=INK)
d.text((74, 352), "Claude Code in your Obsidian sidebar", font=font(30), fill=MUTED)
for i, line in enumerate(["Streamed replies and tool calls", "Diffs you approve before edits land", "Plan mode, @ mentions, session history"]):
    yy = 420 + i * 40
    d.ellipse([76, yy + 11, 86, yy + 21], fill=ACCENT)
    d.text((100, yy), line, font=font(24), fill=INK)

shot = Image.open("assets/permission.png").convert("RGB")
shot = shot.crop((0, 655, shot.width, shot.height))
target_h = 560
shot = shot.resize((round(shot.width * target_h / shot.height), target_h), Image.LANCZOS)
sx, sy = W - shot.width - 64, (H - target_h) // 2
shadow = Image.new("RGBA", (shot.width + 60, shot.height + 60), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([30, 34, shot.width + 30, shot.height + 34], radius=18, fill=(0, 0, 0, 60))
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
img.paste(shadow, (sx - 30, sy - 30), shadow)
mask = Image.new("L", shot.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, shot.width, shot.height], radius=16, fill=255)
img.paste(shot, (sx, sy), mask)
d.rounded_rectangle([sx, sy, sx + shot.width, sy + shot.height], radius=16, outline=(224, 220, 214), width=2)
img.save("assets/social-preview.png", optimize=True)
