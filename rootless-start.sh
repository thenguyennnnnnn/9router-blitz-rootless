#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
PORT="${PORT:-20128}"
HOSTNAME="${HOSTNAME:-0.0.0.0}"

log() {
  printf '%s\n' "[9router-rootless] $*"
}

log "uid=$(id -u) gid=$(id -g) data=${DATA_DIR} port=${PORT} host=${HOSTNAME}"

# Fail with a useful message instead of crash-looping with an opaque SQLite EACCES later.
if [ ! -d "$DATA_DIR" ]; then
  if ! mkdir -p "$DATA_DIR" 2>/dev/null; then
    log "ERROR: cannot create DATA_DIR: $DATA_DIR"
    log "blitz.cloud must keep /app/data and make it writable by uid 1000."
    exit 73
  fi
fi

if [ ! -w "$DATA_DIR" ]; then
  log "ERROR: DATA_DIR is not writable by uid $(id -u): $DATA_DIR"
  ls -ld "$DATA_DIR" 2>/dev/null || true
  log "Do not switch to /tmp if you need persistent accounts/config. Fix the kept-folder permissions instead."
  exit 73
fi

# Ensure the main DB directory can be created before launching the app.
if ! mkdir -p "$DATA_DIR/db" 2>/dev/null; then
  log "ERROR: cannot create $DATA_DIR/db"
  exit 73
fi

# Temporary migration mode check
MIGRATION_MODE="${MIGRATION_MODE:-false}"

if [ "$MIGRATION_MODE" = "true" ]; then
  log "MIGRATION_MODE=true is active."
  log "9Router main application will NOT start."
  log "Starting temporary migration server on port ${PORT}..."
  exec node /usr/local/bin/migration-server.js
fi

log "starting 9Router..."
exec node custom-server.js
