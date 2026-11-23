#!/bin/sh
# Starts NotionKeeper as PUID:PGID (default 1000:1000) instead of root.
#
# Started as root (the default), it first hands the downloads directory to
# that user: backups written by earlier, root-running versions are root-owned,
# and retention could no longer delete them. Started as non-root (`user:` in
# compose, `--user` on docker run), it runs the command as is and the
# directory must already be writable by that user.
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}
DOWNLOADS=${DOWNLOADS_DIRECTORY_PATH:-/downloads}

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DOWNLOADS"
  # Never recurse from the filesystem root, whatever the variable says.
  if [ "$(realpath "$DOWNLOADS")" != / ] \
    && [ "$(stat -c %u:%g "$DOWNLOADS")" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DOWNLOADS"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

exec "$@"
