# PlatformIO pre-script: builds the wake word model header from firmware/models/.
#
# A board names its model in platformio.ini:
#     custom_wake_model = hey_vortex
# and gets a generated model_builtin.h on the include path. The header is a
# build product, never committed, so the .tflite stays the only source of truth.
Import("env")
import os
import subprocess
import sys

firmware = os.path.abspath(os.path.join(env.subst("$PROJECT_DIR"), ".."))
name = env.GetProjectOption("custom_wake_model")
tflite = os.path.join(firmware, "models", name + ".tflite")
manifest = os.path.join(firmware, "models", name + ".json")
generator = os.path.join(firmware, "tools", "gen_model_header.py")
outdir = os.path.join(env.subst("$BUILD_DIR"), "generated")
out = os.path.join(outdir, "model_builtin.h")

os.makedirs(outdir, exist_ok=True)
sources = [tflite, manifest, generator]
if not os.path.exists(out) or os.path.getmtime(out) < max(os.path.getmtime(s) for s in sources if os.path.exists(s)):
    command = [sys.executable, generator, tflite, "-o", out]
    if os.path.exists(manifest):
        command += ["--json", manifest]
    subprocess.check_call(command)

env.Append(CPPPATH=[outdir])
