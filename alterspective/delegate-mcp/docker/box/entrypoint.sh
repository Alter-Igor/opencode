#!/bin/sh
set -eu
# Fixed argv prevents a caller from starting an inspector or an unguarded alternate command.
[ "$#" -eq 5 ] && [ "$1" = serve ] && [ "$2" = --hostname ] && [ "$3" = 0.0.0.0 ] && [ "$4" = --port ] && [ "$5" = 4096 ] || {
  echo 'box: managed server arguments required' >&2
  exit 1
}
ulimit -c 0
/usr/bin/python3 -I -S /usr/local/lib/ocd-memory-probe.py --startup >/dev/null || {
  echo 'box: server memory/API isolation startup check failed' >&2
  exit 1
}
exec /usr/local/bin/opencode "$@"
