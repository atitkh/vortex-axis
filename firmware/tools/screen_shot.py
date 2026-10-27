#!/usr/bin/env python3
# Asks a board for a picture of its screen (`shot` on its console) and writes it as a PNG: the round 1.75 (466 by 466)
# or the 1.8 (368 by 448). The size is read from the board's `[shot] begin W H` line; --size WxH says it when that is lost.
# Needs pyserial and Pillow. Rows lost on the way are asked for again; any still missing show dark magenta.
#   python3 screen_shot.py OUT.png [--port /dev/ttyACM0] [--held] [--size 368x448] [--turn 90] [--send "preview ask" --wait 2]...
# The picture is as the panel holds it; --turn DEGREES turns it to the screen's rotation, so it reads the right way up.
# Commands given with --send go first, e.g. to put a made-up state on the screen. --held asks for `shot held`: what
# the panel holds as it is, nothing drawn again, so leftovers show (the face may tear, as it moves while rows go out).
import sys, time, re, serial
from PIL import Image, ImageDraw

out = sys.argv[1]
pre = []
port = "/dev/ttyACM0"
command = b"shot\n"
size = None
turn = 0
args = sys.argv[2:]
while args:
    a = args.pop(0)
    if a == "--port":
        port = args.pop(0)
    elif a == "--held":
        command = b"shot held\n"
    elif a == "--size":
        size = tuple(int(v) for v in args.pop(0).lower().split("x"))
    elif a == "--turn":
        turn = int(args.pop(0)) % 360
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
W, H = size or (466, 466)
for attempt in range(4):
    s.reset_input_buffer()
    s.write(command)
    buf = b""
    start = time.time()
    while time.time() - start < 40:
        buf += s.read(65536)
        if b"[shot] end" in buf:
            break
    for line in buf.decode("utf-8", "replace").splitlines():
        b = re.search(r"\[shot\] begin (\d+) (\d+)", line)
        if b and not size:
            W, H = int(b.group(1)), int(b.group(2))
            continue
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
# Where the glass is on the round board: a faint ring just outside the circle.
if W == H:
    d = ImageDraw.Draw(img)
    d.ellipse([-1, -1, W, H], outline=(70, 70, 70))
# At 90 degrees the screen's top is the panel's left (display.cpp, toLogical): turned clockwise; PIL turns anticlockwise.
if turn:
    img = img.rotate(-turn, expand=True)
img.save(out)
print(out)
