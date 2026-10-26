#!/usr/bin/env python3
# Sends a file to a round 1.75 board's `pcm` buffer over the serial console, then one command, and prints the log:
#   python3 send_file.py speech.pcm "pcm play 24000"     16-bit mono samples, played through the speech path
#   python3 send_file.py card.jpg "pcm picture"          a baseline JPEG, shown as a picture from a reply would be
# Lines are paced, since the board's USB serial drops input that comes faster. Set PORT to use another port.
import os, sys, time, base64, serial
path, command = sys.argv[1], sys.argv[2]
secs = float(sys.argv[3]) if len(sys.argv) > 3 else 4
data = open(path, "rb").read()
s = serial.Serial(os.environ.get("PORT", "/dev/ttyACM0"), 115200, timeout=0.05)
def pump(t):
    end = time.time() + t
    while time.time() < end:
        d = s.read(4096)
        if d:
            sys.stdout.write(d.decode("utf-8", "replace")); sys.stdout.flush()
s.write(b"pcm clear\n"); pump(0.2)
for i in range(0, len(data), 150):
    s.write(b"pcm " + base64.b64encode(data[i:i + 150]) + b"\n")
    time.sleep(0.03)
pump(0.5)
s.write((command + "\n").encode())
pump(secs)
