#!/bin/sh
# Starts a speech service as whoever owns the models folder, so a folder made by the person who runs Docker (any user
# id) or by Docker itself (root, when the folder did not exist before the first start) both work without a chown on the host.
set -e
if [ "$(id -u)" = "0" ]; then
  owner=$(stat -c %u /models)
  group=$(stat -c %g /models)
  if [ "$owner" = "0" ]; then
    # Docker made the folder (or it was made with sudo): hand it to the image's own user.
    owner=$(id -u speech)
    group=$(id -g speech)
    chown -R "$owner:$group" /models
  fi
  exec setpriv --reuid="$owner" --regid="$group" --clear-groups "$@"
fi
exec "$@"
