#!/bin/sh
# The core's JVM tests, run in the build image (JDK 17) from clients/quest-client:
#   sh test/run.sh unit                          AdbClientTest, UnitTest, CommandsTest, UpdateTest, HelperTest (fakes only)
#   sh test/run.sh e2e <axis url> <admin token>  E2eTest against a running Axis, with the JDK's WebSocket,
#                                                then again with OkHttp when its jars are in the Gradle cache
set -e
cd "$(dirname "$0")/.."
out=/tmp/quest-client-test
rm -rf "$out" && mkdir -p "$out"
newest() { find /root/.gradle/caches/modules-2 -name "$1" 2>/dev/null | sort -V | tail -1; }
okhttp=""
if [ "$1" = e2e ]; then
  for jar in 'okhttp-4.12.0.jar' 'okio-jvm-3*.jar' 'kotlin-stdlib-1*.jar' 'kotlin-stdlib-jdk7-*.jar' 'kotlin-stdlib-jdk8-*.jar' 'kotlin-stdlib-2*.jar'; do
    found=$(newest "$jar")
    [ -n "$found" ] && okhttp="$okhttp:$found"
  done
  case "$okhttp" in *okhttp-4.12.0.jar*) ;; *) okhttp="" ;; esac
fi
extra=""
[ -n "$okhttp" ] && extra=app/src/main/java/dev/vortexaxis/quest/OkHttpSockets.java
javac -nowarn -encoding UTF-8 -cp "$out$okhttp" -d "$out" $(find core/src test -name '*.java') $extra 2>&1 | grep -v '^Note:' || true
run() { java -Djava.awt.headless=true -Dfile.encoding=UTF-8 -cp "$out$okhttp" "$@"; }
case "$1" in
  unit)
    run dev.vortexaxis.quest.core.AdbClientTest
    run dev.vortexaxis.quest.core.UnitTest
    run dev.vortexaxis.quest.core.CommandsTest
    run dev.vortexaxis.quest.core.UpdateTest
    run dev.vortexaxis.quest.core.HelperTest
    run dev.vortexaxis.quest.core.HandshakeTest
    ;;
  e2e)
    run dev.vortexaxis.quest.core.E2eTest "$2" "$3" jdk
    if [ -n "$okhttp" ]; then run dev.vortexaxis.quest.core.E2eTest "$2" "$3" okhttp
    else echo "OkHttp jars not in the Gradle cache (build the app once): the OkHttp run was skipped"; fi
    ;;
  *) echo "usage: sh test/run.sh unit | e2e <axis url> <admin token>" >&2; exit 2 ;;
esac
