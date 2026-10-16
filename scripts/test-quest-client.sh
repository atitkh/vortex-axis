#!/usr/bin/env bash
# Tests the Quest panel client end to end against a REAL Axis: builds the server from this checkout, starts it in
# Docker (Node 24) on a free port with a throwaway data folder and admin token (holding a pretend newer Quest app
# build), then runs the client's JVM tests and its E2E test (pairing, the socket, the update Axis offers, the
# desktop tool through POST /mcp) in the build image. Nothing is kept.
#   scripts/test-quest-client.sh
set -euo pipefail
cd "$(dirname "$0")/.."
src="$PWD/clients/quest-client"
image=vortex-axis-quest-build
node_image="${AXIS_E2E_NODE_IMAGE:-$(docker image inspect vortex-axis:local > /dev/null 2>&1 && echo vortex-axis:local || echo node:24-slim)}"
npm run build > /dev/null
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
token=$(openssl rand -hex 24)
name="vortex-axis-quest-e2e-$$"
docker build -q -t "$image" "$PWD/clients/quest-client" > /dev/null
docker run -d --rm --name "$name" --network host -v "$PWD":/repo:ro -w /repo \
  -e AXIS_ADMIN_TOKEN="$token" -e AXIS_DATA_DIR=/tmp/axis-data -e AXIS_PORT="$port" -e AXIS_HOST=127.0.0.1 \
  -e AXIS_WEB_DIR=/repo/web -e AXIS_PING_INTERVAL_MS=5000 --entrypoint node "$node_image" server/dist/index.js > /dev/null
trap 'docker logs "$name" > /tmp/quest-e2e-axis.log 2>&1 || true; docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/healthz" > /dev/null && break; sleep 0.2; done
curl -fs "http://127.0.0.1:$port/healthz" > /dev/null || { docker logs "$name"; echo "Axis did not start" >&2; exit 1; }
echo "Axis $(docker exec "$name" node -v) from this checkout on 127.0.0.1:$port (image $node_image)"
# A pretend newer build of the Quest app in its data folder, so the test sees Axis offer it and the client fetch it.
fake=$(mktemp -d)
printf 'not really an APK, for the end-to-end test\n' > "$fake/quest-client.apk"
printf '{"version":"9.9.9","builtAt":"2026-01-01T00:00:00Z"}\n' > "$fake/version.json"
docker exec "$name" mkdir -p /tmp/axis-data/quest
docker cp -q "$fake/." "$name:/tmp/axis-data/quest/"
rm -rf "$fake"
docker run --rm --network host -v "$src":/src -v vortex-axis-quest-probe-gradle:/root/.gradle -w /src "$image" sh -c \
  "{ QUIET=1 sh test/run.sh unit > /tmp/unit.log 2>&1 || { cat /tmp/unit.log; exit 1; }; } && grep 'ALL PASS' /tmp/unit.log && QUIET=1 sh test/run.sh e2e http://127.0.0.1:$port $token"
echo "Axis's log: /tmp/quest-e2e-axis.log"
