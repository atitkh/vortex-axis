#!/usr/bin/env bash
# Builds the Quest panel client (experimental) in Docker: the core's JVM tests first, then the debug APK (with the
# fast engine's helper APK built first and carried inside it as assets/helper.apk), which is copied with a
# version.json to $AXIS_DATA_PATH/quest/. Checks the helper with aapt2 (its package, an instrumentation that targets
# itself) and that the app carries it. Needs Docker; nothing on the host. Uses the Quest probe's build image
# (clients/quest-probe/Dockerfile) and Gradle cache volume; the debug signing key is kept in the volume
# vortex-axis-quest-android, so a new build installs over the last one (adb install -r), and app and helper share it.
#   scripts/build-quest-client.sh        uses AXIS_DATA_PATH from .env
set -euo pipefail
cd "$(dirname "$0")/.."
data="${AXIS_DATA_PATH:-$(grep -E '^AXIS_DATA_PATH=' .env 2>/dev/null | cut -d= -f2- || true)}"
[ -n "$data" ] || { echo "AXIS_DATA_PATH is not set (in the environment or .env)" >&2; exit 1; }
src="$PWD/clients/quest-client"
image=vortex-axis-quest-probe-build
# The app expects the helper it carries to say the app's own version.
for f in versionName versionCode; do
  [ "$(grep -E "^\s*$f " "$src/app/build.gradle")" = "$(grep -E "^\s*$f " "$src/helper/build.gradle")" ] || { echo "$f differs between app/build.gradle and helper/build.gradle" >&2; exit 1; }
done
docker build -q -t "$image" "$PWD/clients/quest-probe" > /dev/null
docker run --rm -v "$src":/src -v vortex-axis-quest-probe-gradle:/root/.gradle -v vortex-axis-quest-android:/root/.android -w /src "$image" sh -c '
    { QUIET=1 sh test/run.sh unit > /tmp/unit.log 2>&1 || { cat /tmp/unit.log; false; }; } && grep "ALL PASS" /tmp/unit.log &&
    gradle --no-daemon -q assembleDebug &&
    mkdir -p .out && cp app/build/outputs/apk/debug/app-debug.apk .out/quest-client.apk &&
    cp helper/build/outputs/apk/debug/helper-debug.apk .out/quest-helper.apk &&
    aapt2 dump badging .out/quest-helper.apk | grep -q "^package: name=.dev.vortexaxis.quest.helper." &&
    aapt2 dump xmltree --file AndroidManifest.xml .out/quest-helper.apk | grep -A4 "E: instrumentation" | grep -q "targetPackage.*=\"dev.vortexaxis.quest.helper\"" &&
    unzip -l .out/quest-client.apk | grep -q " assets/helper.apk$" &&
    echo "helper: dev.vortexaxis.quest.helper, instrumentation targets itself, carried as assets/helper.apk";
    status=$?; chown -R '"$(id -u):$(id -g)"' /src/.out /src/.gradle /src/build /src/app/build /src/helper/build 2>/dev/null; exit $status'
version=$(sed -n "s/.*versionName '\(.*\)'.*/\1/p" "$src/app/build.gradle")
mkdir -p "$data/quest"
cp "$src/.out/quest-client.apk" "$data/quest/quest-client.apk"
printf '{"version":"%s","builtAt":"%s"}\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$data/quest/version.json"
ls -l "$data/quest"
sha256sum "$data/quest/quest-client.apk"
