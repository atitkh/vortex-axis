#!/bin/sh
# Starts Axis as whoever owns the data folder, so a folder made by the person who runs Docker (any user id) or by
# Docker itself (root, when the folder did not exist before the first start) both work without a chown on the host.
set -e
if [ "$(id -u)" = "0" ]; then
  owner=$(stat -c %u /data)
  group=$(stat -c %g /data)
  if [ "$owner" = "0" ]; then
    # Docker made the folder (or it was made with sudo): hand it to the image's own user.
    owner=$(id -u node)
    group=$(id -g node)
    chown -R "$owner:$group" /data
  fi
  # The backup folder: only when Axis could not write to it otherwise.
  if [ -d /backup ] && [ "$(stat -c %u /backup)" = "0" ]; then
    chown "$owner:$group" /backup 2>/dev/null || true
  fi
  exec su-exec "$owner:$group" "$@"
fi
exec "$@"
