# Draws the Mac app icon's master (App/AppIcon-1024.png) from the web app's 512 px logo (web/icon-512.png, the same picture as
# the Windows app's logo.png, larger): a dark rounded plate on macOS's icon grid (824 of 1024), the logo's dots redrawn
# crisply at the new size, the merged middle scaled up as it is. Needs Python 3 with Pillow, numpy and scipy; run once
# when the logo changes, then scripts/make-icns.sh:
#   python3 scripts/draw-app-icon.py ../../web/icon-512.png App/AppIcon-1024.png
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

src, out = sys.argv[1], sys.argv[2]
SS = 4                       # supersampling
CANVAS, PLATE, RADIUS = 1024, 824, 186
a = np.asarray(Image.open(src).convert('RGBA')).astype(float)
lum = a[..., :3].max(axis=2) * a[..., 3] / 255
mask = lum > 30
lab, n = ndimage.label(mask)
ys, xs = np.nonzero(mask)
cx0, cy0 = 256.0, 256.0
extent = max(np.hypot(xs - cx0, ys - cy0)) + 12
scale = (PLATE * 0.40) / extent            # the spiral's reach takes 80 % of the plate's width
S = CANVAS * SS
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img, 'RGBA')
# The plate: lighter at the top, as the pills, with a faint edge.
plate = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = np.zeros((S, S, 4), dtype=np.uint8)
top, bottom = np.array([0x1E, 0x20, 0x2B]), np.array([0x08, 0x08, 0x0D])
f = np.linspace(0, 1, S)[:, None]
grad[..., :3] = (top * (1 - f) + bottom * f)[:, None, :].astype(np.uint8).repeat(1, axis=1).reshape(S, 1, 3).repeat(S, axis=1)
grad[..., 3] = 255
pm = Image.new('L', (S, S), 0)
o = (CANVAS - PLATE) // 2 * SS
ImageDraw.Draw(pm).rounded_rectangle([o, o, o + PLATE * SS, o + PLATE * SS], radius=RADIUS * SS, fill=255)
plate = Image.composite(Image.fromarray(grad, 'RGBA'), plate, pm)
ImageDraw.Draw(plate).rounded_rectangle([o, o, o + PLATE * SS, o + PLATE * SS], radius=RADIUS * SS, outline=(255, 255, 255, 22), width=2 * SS)
img = Image.alpha_composite(img, plate)
# Glows and dots on layers of their own (drawing on an RGBA image replaces pixels instead of blending).
glows = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(glows)
k = scale * SS
C = CANVAS * SS / 2
def at(x, y): return C + (x - cx0) * k, C + (y - cy0) * k
big = []
for i in range(1, n + 1):
    yy, xx = np.nonzero(lab == i)
    if len(xx) > 1200:
        big.append(i)
        continue
    w = lum[yy, xx]
    x, y = (xx * w).sum() / w.sum(), (yy * w).sum() / w.sum()
    r = (len(xx) / np.pi) ** 0.5 + 0.4
    p = np.argmax(w)
    col = tuple(int(c) for c in a[yy[p], xx[p], :3])
    X, Y = at(x, y)
    # A little glow of its own colour, as the face draws.
    d.ellipse([X - r * 2.2 * k, Y - r * 2.2 * k, X + r * 2.2 * k, Y + r * 2.2 * k], fill=col + (16,))
dots = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(dots)
for i in range(1, n + 1):
    if i in big: continue
    yy, xx = np.nonzero(lab == i)
    w = lum[yy, xx]
    x, y = (xx * w).sum() / w.sum(), (yy * w).sum() / w.sum()
    r = (len(xx) / np.pi) ** 0.5 + 0.4
    p = np.argmax(w)
    col = tuple(int(c) for c in a[yy[p], xx[p], :3])
    X, Y = at(x, y)
    d.ellipse([X - r * k, Y - r * k, X + r * k, Y + r * k], fill=col + (255,))
img = Image.alpha_composite(Image.alpha_composite(img, glows), dots)
small = img.resize((CANVAS, CANVAS), Image.LANCZOS)
# The merged middle (the core and the smallest dots): the logo's own pixels, scaled up, laid over with their light.
if big:
    m = np.isin(lab, big)
    m = ndimage.binary_dilation(m, iterations=3)
    yy, xx = np.nonzero(m)
    x0, x1, y0, y1 = xx.min(), xx.max() + 1, yy.min(), yy.max() + 1
    crop = Image.fromarray(a[y0:y1, x0:x1].astype(np.uint8), 'RGBA')
    alpha = Image.fromarray((np.clip(lum[y0:y1, x0:x1] * 2.2, 0, 255) * m[y0:y1, x0:x1]).astype(np.uint8), 'L')
    crop.putalpha(alpha)
    w, h = round((x1 - x0) * scale), round((y1 - y0) * scale)
    crop = crop.resize((w, h), Image.LANCZOS)
    X, Y = at(x0, y0)
    small.alpha_composite(crop, (round(X / SS), round(Y / SS)))
small.save(out)
print('scale', round(scale, 3), 'dots', n - len(big), 'merged', len(big))
