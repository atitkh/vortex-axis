#!/usr/bin/env bash
# Builds the throwaway Quest probe (two debug APKs) in Docker and copies them to $AXIS_DATA_PATH/quest-probe/.
# Needs Docker; nothing on the host. The Gradle cache is kept in a named volume so a second build is quick.
#   scripts/build-quest-probe.sh        uses AXIS_DATA_PATH from .env
set -euo pipefail
cd "$(dirname "$0")/.."
data="${AXIS_DATA_PATH:-$(grep -E '^AXIS_DATA_PATH=' .env 2>/dev/null | cut -d= -f2- || true)}"
[ -n "$data" ] || { echo "AXIS_DATA_PATH is not set (in the environment or .env)" >&2; exit 1; }
src="$PWD/clients/quest-probe"
image=vortex-axis-quest-probe-build
docker build -q -t "$image" "$src" > /dev/null
docker run --rm -v "$src":/src -v vortex-axis-quest-probe-gradle:/root/.gradle -w /src "$image" sh -c '
    gradle --no-daemon -q assembleDebug assembleDebugAndroidTest &&
    mkdir -p .out && cp app/build/outputs/apk/debug/app-debug.apk .out/quest-probe.apk &&
    cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk .out/quest-probe-test.apk;
    status=$?; chown -R '"$(id -u):$(id -g)"' /src/.out /src/.gradle /src/build /src/app/build 2>/dev/null; exit $status'
mkdir -p "$data/quest-probe"
cp "$src/.out/quest-probe.apk" "$src/.out/quest-probe-test.apk" "$data/quest-probe/"
ls -l "$data/quest-probe"
