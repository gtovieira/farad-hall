#!/bin/sh
# Nightly pg_dump of the Hall database into /backups (a host directory), keeping BACKUP_KEEP_DAYS
# days. Runs in the postgres image (pg_dump of the same major version). Copy /backups off the
# server too (deploy/README section in the root README: "Backups").
set -eu

HOUR="${BACKUP_HOUR_UTC:-6}"          # 06:00 UTC = 03:00 in Brasília
KEEP="${BACKUP_KEEP_DAYS:-14}"
DIR=/backups

dump() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  file="$DIR/hall-$stamp.dump"
  if pg_dump --format=custom --compress=6 --file="$file.part"; then
    mv "$file.part" "$file"
    echo "backup: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.part"
    echo "backup: pg_dump FAILED" >&2
    return 1
  fi
  find "$DIR" -name 'hall-*.dump' -mtime +"$KEEP" -print -delete
}

until pg_isready -q; do sleep 2; done
if [ "${BACKUP_ON_START:-0}" = "1" ]; then dump || true; fi

while :; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $(printf '%02d' "$HOUR"):00:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  echo "backup: next at $(date -u -d "@$next" '+%Y-%m-%d %H:%M') UTC"
  sleep $((next - now))
  dump || true
done
