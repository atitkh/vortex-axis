#!/bin/sh
# Copies the Axis data folder to a second place, for when the folder Axis runs
# from is on a local disk and the copy should sit on shared storage.
#
#   scripts/backup-data.sh <data folder> <backup folder>
#
# The database is copied with SQLite's own backup, so the copy is whole even if
# Axis writes while it runs. Firmware and wake word files are mirrored as they
# are. One dated copy of the database a day is kept for a week under daily/.
#
# Each run leaves backup-status.json in the data folder, saying when it ran and
# whether it worked. The admin page's Integrations section reads it.
set -eu
src=${1:?data folder}
dst=${2:?backup folder}
snap=
status() {
  printf '{"at":"%s","ok":%s,"to":"%s","note":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$dst" "$2" > "$src/backup-status.json" 2>/dev/null || true
}
trap 'code=$?; [ -n "$snap" ] && rm -f "$snap"; [ "$code" -eq 0 ] || status false "The copy failed. The reason is in backup.log in the data folder."' EXIT
[ -f "$src/axis.sqlite" ] || { echo "no database in $src" >&2; exit 1; }
[ -d "$dst" ] || { echo "$dst is not there (is the share mounted?)" >&2; exit 1; }

snap=$(mktemp "${TMPDIR:-/tmp}/axis-backup.XXXXXX")
python3 - "$src/axis.sqlite" "$snap" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=30)
out = sqlite3.connect(sys.argv[2])
src.backup(out)
if out.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    sys.exit("the copy of the database failed its check")
out.close(); src.close()
PY

mkdir -p "$dst/daily"
cp "$snap" "$dst/axis.sqlite.part" && mv "$dst/axis.sqlite.part" "$dst/axis.sqlite"
today="$dst/daily/axis-$(date +%F).sqlite"
[ -f "$today" ] || cp "$snap" "$today"
find "$dst/daily" -name 'axis-*.sqlite' -mtime +7 -delete
for part in firmware wakewords; do
  [ -d "$src/$part" ] && rsync -a --delete "$src/$part/" "$dst/$part/"
done
date -u +%FT%TZ > "$dst/last-backup"
status true ""
