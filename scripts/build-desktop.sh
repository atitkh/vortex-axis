#!/usr/bin/env bash
# Builds the Windows desktop app (experimental) in the .NET SDK container and puts it in Axis's data
# folder, where the admin page's "Add a device" offers it for download. Needs Docker; nothing on the host.
#   scripts/build-desktop.sh            uses AXIS_DATA_PATH from .env
set -euo pipefail
cd "$(dirname "$0")/.."
data="${AXIS_DATA_PATH:-$(grep -E '^AXIS_DATA_PATH=' .env 2>/dev/null | cut -d= -f2- || true)}"
[ -n "$data" ] || { echo "AXIS_DATA_PATH is not set (in the environment or .env)" >&2; exit 1; }
src="$PWD/clients/windows-desktop"
version=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$src/Directory.Build.props")
docker run --rm -v "$src":/src -w /src/VortexDesktop -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  mcr.microsoft.com/dotnet/sdk:8.0 sh -c '
    dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true \
      -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o /src/.out/win-x64 -nologo -v q &&
    chown -R '"$(id -u):$(id -g)"' /src/.out /src/VortexDesktop/bin /src/VortexDesktop/obj /src/Axis.Desktop.Core/bin /src/Axis.Desktop.Core/obj'
mkdir -p "$data/desktop"
cp "$src/.out/win-x64/VortexAxisDesktop.exe" "$data/desktop/VortexAxisDesktop.exe"
printf '{"version":"%s","builtAt":"%s"}\n' "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$data/desktop/version.json"
echo "desktop app $version: $(du -h "$data/desktop/VortexAxisDesktop.exe" | cut -f1) in $data/desktop"
