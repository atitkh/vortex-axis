#!/bin/bash
# Builds "VorteX Axis.app" into clients/macos-desktop/build/ from the Swift package. Run on a Mac; needs Xcode or the
# Command Line Tools (Swift 5.9 or newer). Nothing is uploaded or installed: copy the app to ~/Applications yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

# One version, written in Sources/VortexAxisMac/App.swift; Info.plist is given the same.
VERSION=$(sed -n 's/^let appVersion = "\(.*\)"$/\1/p' Sources/VortexAxisMac/App.swift)
[[ -n "$VERSION" ]] || { echo "no appVersion in Sources/VortexAxisMac/App.swift" >&2; exit 1; }

swift build -c release --product VortexAxisMac

# Assembled and signed outside the checkout: iCloud-synced folders (Documents, Desktop) attach Finder info to the
# bundle, which codesign rejects. The signed app is then copied into build/.
FINAL="build/VorteX Axis.app"
STAGE=$(mktemp -d)
APP="$STAGE/VorteX Axis.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/VortexAxisMac" "$APP/Contents/MacOS/VortexAxisMac"
cp App/Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"

# Accessibility and Screen Recording are granted to a signing identity. Sign with a Developer ID or Apple Development
# certificate when the keychain has one, so the grants survive rebuilds; otherwise ad hoc (they reset every build).
# The certificate's hash, not its name: the same name can be in the keychain twice.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -E '"(Developer ID Application|Apple Development)' | grep -v REVOKED | head -1 | awk '{print $2}' || true)
codesign --force --options runtime --sign "${IDENTITY:--}" "$APP"
# macOS will not start an app whose certificate Apple revoked, even when the keychain still lists it as valid.
if [[ "$(spctl -a -vv "$APP" 2>&1 || true)" == *REVOKED* ]]; then
  echo "The signing certificate is revoked; signing ad hoc instead"
  codesign --force --sign - "$APP"
  IDENTITY=""
fi

rm -rf "$FINAL"
mkdir -p build
ditto --norsrc --noextattr "$APP" "$FINAL"
rm -rf "$STAGE"

if [[ -n "$IDENTITY" ]]; then SIGNED="with $IDENTITY"; else SIGNED="ad hoc (permissions reset on every build)"; fi
echo "Built $FINAL $VERSION, signed $SIGNED"
echo "Run it with: open \"$FINAL\""
