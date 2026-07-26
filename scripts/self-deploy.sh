#!/bin/bash
# scripts/self-deploy.sh — detached, rollback-safe deploy orchestrator.
#
# Launched (detached, in its own session) by src/self-deploy/github-webhook.ts
# when a PR is merged to the deploy branch. Because it must survive the host
# restart it triggers, it is plain bash with no dependency on the dist/ it
# overwrites.
#
#   self-deploy.sh <PROJECT_ROOT>
#
# Flow: snapshot DB → fast-forward to origin/<branch> → install → build →
# (rebuild image if container/ changed) → restart → health-check via the
# readiness marker. ANY failure rolls back to the last-known-good commit AND
# the DB snapshot, rebuilds, and restarts, so the assistant is never lost.
#
# It writes data/.deploy-result.json; the running/rolled-back host drains that
# on its next sweep and has the assistant report the outcome to the operator.
#
# NOTE: no `set -e` — failures are handled explicitly so we can roll back.
set -uo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
cd "$PROJECT_ROOT" || exit 1

DATA_DIR="$PROJECT_ROOT/data"
MARKER="$DATA_DIR/.host-ready"
RESULT="$DATA_DIR/.deploy-result.json"
LAST_GOOD_FILE="$DATA_DIR/.last-good-commit"
mkdir -p "$DATA_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# ---- config from .env --------------------------------------------------------
read_env() { # key default
  local v=""
  if [ -f "$PROJECT_ROOT/.env" ]; then
    v="$(grep -E "^$1=" "$PROJECT_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' ' | tr -d '[:space:]')"
  fi
  echo "${v:-$2}"
}
BRANCH="$(read_env SELF_DEPLOY_BRANCH main)"
HEALTH_TIMEOUT_MS="$(read_env SELF_DEPLOY_HEALTH_TIMEOUT_MS 120000)"
HEALTH_TIMEOUT_S=$(( HEALTH_TIMEOUT_MS / 1000 ))
[ "$HEALTH_TIMEOUT_S" -lt 30 ] && HEALTH_TIMEOUT_S=30

# ---- service control (slug-derived unit; user/system/nohup) ------------------
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
UNIT="$(systemd_unit)"
MODE=""
detect_mode() {
  if systemctl --user cat "${UNIT}.service" >/dev/null 2>&1; then MODE=user
  elif systemctl cat "${UNIT}.service" >/dev/null 2>&1; then MODE=system
  else MODE=nohup; fi
  log "service mode: $MODE (unit $UNIT)"
}
stop_service() {
  case "$MODE" in
    user)   systemctl --user stop "$UNIT" 2>/dev/null || true ;;
    system) systemctl stop "$UNIT" 2>/dev/null || true ;;
    nohup)  pkill -f "$PROJECT_ROOT/dist/index.js" 2>/dev/null || true ;;
  esac
}
start_service() {
  case "$MODE" in
    user)   systemctl --user start "$UNIT" ;;
    system) systemctl start "$UNIT" ;;
    nohup)  nohup node "$PROJECT_ROOT/dist/index.js" \
              >> "$PROJECT_ROOT/logs/nanoclaw.log" 2>> "$PROJECT_ROOT/logs/nanoclaw.error.log" & ;;
  esac
}

# ---- readiness marker polling ------------------------------------------------
marker_mtime() { stat -c %Y "$MARKER" 2>/dev/null || echo 0; }
marker_commit() { grep -o '"commit":"[0-9a-f]*"' "$MARKER" 2>/dev/null | head -1 | sed 's/.*:"//; s/"//'; }
wait_for_health() { # target_commit restart_epoch
  local target="$1" since="$2" deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$MARKER" ] && [ "$(marker_mtime)" -ge "$since" ] && [ "$(marker_commit)" = "$target" ]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# ---- deploy result (drained by the host sweep → reported to operator) --------
write_result() { # status from to error
  local err; err="$(echo "${4:-}" | tr -d '"' | tr '\n' ' ')"
  printf '{"status":"%s","from":"%s","to":"%s","error":"%s","ts":"%s"}\n' \
    "$1" "$2" "$3" "$err" "$(date -u +%FT%TZ)" > "$RESULT"
}

# ---- single-flight -----------------------------------------------------------
exec 9>"$DATA_DIR/.self-deploy.lock"
if ! flock -n 9; then log "deploy already in progress — exiting"; exit 0; fi

detect_mode

LAST_GOOD="$(git rev-parse HEAD)"
echo "$LAST_GOOD" > "$LAST_GOOD_FILE"
log "last-good commit: $LAST_GOOD"

# ---- DB snapshot (before anything mutates) -----------------------------------
BACKUP_DIR="$DATA_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
if ! pnpm exec tsx scripts/backup-db.ts "$DATA_DIR/v2.db" "$BACKUP_DIR/v2.db"; then
  log "DB snapshot failed — aborting before any change"
  write_result failed "$LAST_GOOD" "$LAST_GOOD" "DB snapshot failed; no changes made"
  exit 1
fi
log "DB snapshot → $BACKUP_DIR/v2.db"

# Atomically restore the pre-deploy DB snapshot. A naive `cp -f snap v2.db`
# truncates the live DB *before* writing, so a mid-copy failure (e.g. ENOSPC)
# leaves an empty v2.db and — with the WAL then deleted — destroys a database
# the failed deploy had never even touched. Instead copy to a temp file on the
# same filesystem and rename into place; only drop the stale WAL/SHM once the
# swap has succeeded. On any failure, leave the live DB exactly as it was.
restore_db_snapshot() {
  local snap="$BACKUP_DIR/v2.db" tmp="$DATA_DIR/v2.db.rollback.tmp"
  if [ ! -s "$snap" ]; then
    log "rollback: DB snapshot missing/empty ($snap) — leaving live DB untouched"
    return 1
  fi
  rm -f "$tmp"
  if ! cp -f "$snap" "$tmp"; then
    log "rollback: DB snapshot copy failed (disk full?) — leaving live DB untouched"
    rm -f "$tmp"
    return 1
  fi
  sync "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$DATA_DIR/v2.db"; then
    log "rollback: DB snapshot rename failed — leaving live DB untouched"
    rm -f "$tmp"
    return 1
  fi
  rm -f "$DATA_DIR/v2.db-wal" "$DATA_DIR/v2.db-shm"
  log "rollback: DB restored from snapshot"
  return 0
}

rollback() { # reason
  log "ROLLBACK: $1"
  stop_service
  git reset --hard "$LAST_GOOD" >/dev/null 2>&1
  restore_db_snapshot || true
  pnpm install --frozen-lockfile >/dev/null 2>&1 || log "rollback: pnpm install warned"
  pnpm run build >/dev/null 2>&1 || log "rollback: build warned"
  if [ "${IMAGE_REBUILT:-0}" = "1" ]; then
    ./container/build.sh >/dev/null 2>&1 || log "rollback: image rebuild warned"
  fi
  rm -f "$DATA_DIR/circuit-breaker.json"
  local since; since=$(date +%s)
  start_service
  if wait_for_health "$LAST_GOOD" "$since"; then
    log "rollback healthy on $LAST_GOOD"
  else
    log "ROLLBACK HEALTH CHECK TIMED OUT — relying on systemd Restart=always with restored tree/DB"
  fi
  write_result rollback "$LAST_GOOD" "${TARGET:-?}" "$1"
  exit 1
}

# ---- fetch + fast-forward ----------------------------------------------------
if ! git fetch origin "$BRANCH" >/dev/null 2>&1; then
  write_result failed "$LAST_GOOD" "$LAST_GOOD" "git fetch failed"
  exit 1
fi
TARGET="$(git rev-parse "origin/$BRANCH")"
if [ "$TARGET" = "$LAST_GOOD" ]; then
  log "already up to date ($TARGET) — nothing to deploy"
  write_result noop "$LAST_GOOD" "$TARGET" "already up to date; nothing to deploy"
  exit 0
fi

# Tracked-file dirtiness blocks a clean reset; gitignored install state does not.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "working tree has tracked changes — refusing to deploy"
  write_result failed "$LAST_GOOD" "$TARGET" "working tree dirty (tracked changes); refusing to overwrite"
  exit 1
fi

log "deploying $LAST_GOOD → $TARGET"
git reset --hard "origin/$BRANCH" >/dev/null 2>&1 || rollback "git reset to origin/$BRANCH failed"
DIFF="$(git diff --name-only "$LAST_GOOD" "$TARGET")"

# ---- install + build ---------------------------------------------------------
if ! pnpm install --frozen-lockfile; then
  rollback "pnpm install --frozen-lockfile failed (a freshly-merged dependency may be <3 days old and blocked by the supply-chain release-age gate; retry after the gate window)"
fi
if ! pnpm run build; then
  rollback "host build (tsc) failed"
fi

# ---- conditional container image rebuild -------------------------------------
IMAGE_REBUILT=0
if echo "$DIFF" | grep -qE '^container/'; then
  log "container/ changed — rebuilding agent image"
  if command -v docker >/dev/null 2>&1; then
    docker buildx prune -f >/dev/null 2>&1 || true   # defeat stale COPY cache
    docker image prune -f >/dev/null 2>&1 || true    # reclaim dangling layers
    # Preflight free disk: a rebuild that runs out of space aborts mid-layer
    # and forces a rollback. Bail out cleanly *before* mutating the running
    # install if there isn't enough headroom to build the ~3GB agent image.
    MIN_FREE_MB="$(read_env SELF_DEPLOY_MIN_FREE_MB 4096)"
    AVAIL_MB="$(df -Pk "$DATA_DIR" | awk 'NR==2{print int($4/1024)}')"
    if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
      rollback "insufficient disk for container rebuild: ${AVAIL_MB}MB free < ${MIN_FREE_MB}MB required (freed build cache + dangling images but still low)"
    fi
  fi
  if ! ./container/build.sh; then
    rollback "container image rebuild failed"
  fi
  IMAGE_REBUILT=1
fi

# ---- restart + health check --------------------------------------------------
rm -f "$DATA_DIR/circuit-breaker.json"   # don't let backoff throttle the new boot
RESTART_EPOCH=$(date +%s)
log "restarting service for $TARGET"
stop_service
start_service
if wait_for_health "$TARGET" "$RESTART_EPOCH"; then
  log "deploy healthy on $TARGET"
  write_result success "$LAST_GOOD" "$TARGET" ""
  # retain only the 5 newest backups
  ls -1dt "$DATA_DIR"/backups/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
  exit 0
else
  rollback "new code did not become healthy within ${HEALTH_TIMEOUT_S}s (boot crash or hang)"
fi
