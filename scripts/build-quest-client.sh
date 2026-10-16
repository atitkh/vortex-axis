#!/usr/bin/env bash
# Builds the Quest panel client (experimental) in Docker: the core's JVM tests first, then the debug APK (with the
# fast engine's helper APK built first and carried inside it as assets/helper.apk), which is copied with a
# version.json to $AXIS_DATA_PATH/quest/ (or to $AXIS_QUEST_OUT, which the release workflow uses). Checks the
# helper with aapt2 (its package, an instrumentation that targets itself) and that the app carries it. Needs Docker;
# nothing on the host. The source goes into the build container by copy, not a bind mount, so this also works where
# the shell itself runs in a container (a CI runner). The debug signing key is kept in the volume
# vortex-axis-quest-android, so a new build installs over the last one (adb install -r), and app and helper share it.
# On a CI runner the volume starts empty, so set QUEST_KEYSTORE_B64 (a base64 debug.keystore) to keep one key across
# releases; without it each release is signed with a fresh key and a headset must uninstall before installing the next.
#   scripts/build-quest-client.sh        uses AXIS_DATA_PATH from .env
set -euo pipefail
cd "$(dirname "$0")/.."
out="${AXIS_QUEST_OUT:-}"
if [ -z "$out" ]; then
  data="${AXIS_DATA_PATH:-$(grep -E '^AXIS_DATA_PATH=' .env 2>/dev/null | cut -d= -f2- || true)}"
  [ -n "$data" ] || { echo "AXIS_DATA_PATH is not set (in the environment or .env); or set AXIS_QUEST_OUT" >&2; exit 1; }
  out="$data/quest"
fi
src="$PWD/clients/quest-client"
image=vortex-axis-quest-build
# The app expects the helper it carries to say the app's own version.
for f in versionName versionCode; do
  [ "$(grep -E "^\s*$f " "$src/app/build.gradle")" = "$(grep -E "^\s*$f " "$src/helper/build.gradle")" ] || { echo "$f differs between app/build.gradle and helper/build.gradle" >&2; exit 1; }
done
docker build -q -t "$image" "$src" > /dev/null
rm -rf "$src/.out"
name="vortex-axis-quest-build-$$"
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
docker create --name "$name" -e QUEST_KEYSTORE_B64="${QUEST_KEYSTORE_B64:-}" \
  -v vortex-axis-quest-probe-gradle:/root/.gradle -v vortex-axis-quest-android:/root/.android -w /src "$image" sh -c '
    if [ -n "$QUEST_KEYSTORE_B64" ]; then mkdir -p /root/.android && printf %s "$QUEST_KEYSTORE_B64" | base64 -d > /root/.android/debug.keystore; fi &&
    { QUIET=1 sh test/run.sh unit > /tmp/unit.log 2>&1 || { cat /tmp/unit.log; false; }; } && grep "ALL PASS" /tmp/unit.log &&
    gradle --no-daemon -q assembleDebug &&
    mkdir -p .out && cp app/build/outputs/apk/debug/app-debug.apk .out/quest-client.apk &&
    cp helper/build/outputs/apk/debug/helper-debug.apk .out/quest-helper.apk &&
    aapt2 dump badging .out/quest-helper.apk | grep -q "^package: name=.dev.vortexaxis.quest.helper." &&
    aapt2 dump xmltree --file AndroidManifest.xml .out/quest-helper.apk | grep -A4 "E: instrumentation" | grep -q "targetPackage.*=\"dev.vortexaxis.quest.helper\"" &&
    unzip -l .out/quest-client.apk | grep -q " assets/helper.apk$" &&
    echo "helper: dev.vortexaxis.quest.helper, instrumentation targets itself, carried as assets/helper.apk"' > /dev/null
docker cp "$src/." "$name:/src"
docker start -a "$name"
docker cp "$name:/src/.out" "$src/.out"
version=$(sed -n "s/.*versionName '\(.*\)'.*/\1/p" "$src/app/build.gradle")
mkdir -p "$out"
cp "$src/.out/quest-client.apk" "$out/quest-client.apk"
printf '{"version":"%s","builtAt":"%s"}\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/version.json"
ls -l "$out"
sha256sum "$out/quest-client.apk"
