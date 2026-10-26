#!/usr/bin/env python3
# Asks a round 1.75 board for a picture of its screen (`shot` on its console) and writes it as a PNG.
# Needs pyserial and Pillow. Rows lost on the way are asked for again; any still missing show dark magenta.
#   python3 screen_shot.py OUT.png [--port /dev/ttyACM0] [--send "preview ask" --wait 2]...
# Commands given with --send go first, e.g. to put a made-up state on the screen.
import sys, time, re, serial
from PIL import Image, ImageDraw

out = sys.argv[1]
pre = []
port = "/dev/ttyACM0"
args = sys.argv[2:]
while args:
    a = args.pop(0)
    if a == "--port":
        port = args.pop(0)
    elif a == "--send":
        pre.append(("send", args.pop(0)))
    elif a == "--wait":
        pre.append(("wait", float(args.pop(0))))

s = serial.Serial(port, 115200, timeout=0.2)
for kind, value in pre:
    if kind == "send":
        s.write((value + "\n").encode())
    else:
        end = time.time() + value
        while time.time() < end:
            s.read(4096)

rows = {}
W = H = 466
for attempt in range(4):
    s.reset_input_buffer()
    s.write(b"shot\n")
    buf = b""
    start = time.time()
    while time.time() - start < 40:
        buf += s.read(65536)
        if b"[shot] end" in buf:
            break
    for line in buf.decode("utf-8", "replace").splitlines():
        m = re.search(r"\[shot\] (\d+) ([0-9a-f]+) ([0-9a-f]+)$", line)
        if not m:
            continue
        y, data, chk = int(m.group(1)), m.group(2), int(m.group(3), 16)
        if len(data) % 7:
            continue
        runs = [(int(data[i:i + 3], 16), int(data[i + 3:i + 7], 16)) for i in range(0, len(data), 7)]
        if sum(n + c for n, c in runs) & 0xFFFF != chk or sum(n for n, _ in runs) != W:
            continue
        rows[y] = runs
    missing = [y for y in range(H) if y not in rows]
    print(f"attempt {attempt + 1}: {H - len(missing)} of {H} rows", file=sys.stderr)
    if not missing:
        break
s.close()

img = Image.new("RGB", (W, H), (60, 0, 60))  # magenta where a row never arrived
px = img.load()
for y, runs in rows.items():
    x = 0
    for n, c in runs:
        r, g, b = ((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31
        for i in range(n):
            px[x + i, y] = (r, g, b)
        x += n
# Where the glass is: a faint ring just outside the circle.
d = ImageDraw.Draw(img)
d.ellipse([-1, -1, W, H], outline=(70, 70, 70))
img.save(out)
print(out)
