#!/bin/bash
# Makes App/AppIcon.iconset and App/AppIcon.icns from one square picture with the Mac's own tools (sips, iconutil), so
# the build needs nothing else: both are committed. Run on a Mac when the logo changes:
#   scripts/make-icns.sh                                              # from App/AppIcon-1024.png (the plate and the logo)
#   scripts/make-icns.sh ../windows-desktop/VortexDesktop/logo.png    # straight from the Windows app's logo (64 px: soft)
# App/AppIcon-1024.png is drawn from the logo by scripts/draw-app-icon.py (Python with Pillow; see there).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-App/AppIcon-1024.png}"
[[ -f "$SRC" ]] || { echo "no picture at $SRC" >&2; exit 1; }
SET="App/AppIcon.iconset"
rm -rf "$SET"
mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$SRC" --out "$SET/icon_${size}x${size}.png" >/dev/null
  sips -s format png -z $((size * 2)) $((size * 2)) "$SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o App/AppIcon.icns
echo "Wrote $SET and App/AppIcon.icns from $SRC"
