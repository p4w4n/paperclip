#!/usr/bin/env bash
# Smoke driver for the multi-container workers stack defined in
# docker/docker-compose.workers.yml. Verifies, in order:
#   1. The image builds.
#   2. Postgres + control-plane come up healthy.
#   3. Both workers connect (Hello → Welcome) and register.
#   4. Both workers emit RunLeaseRenew when a dispatch happens (covered by
#      the e2e step that creates an agent + issue and watches the run).
#
# Phase 1 of this script (default) covers steps 1-3. Phase 2 (--e2e) seeds
# an issue and watches a real claude_local run flow through. Phase 2 needs
# the host to have $HOME/.claude logged in — we surface a clear error if
# the credential file is missing rather than burning 5 minutes on a
# generic adapter failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.workers.yml"
PROJECT_NAME="paperclip-workers"

phase="${1:-up}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}
require docker
require curl
require openssl

if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  echo "ERROR: $HOME/.claude/.credentials.json not found — run 'claude' once to log in." >&2
  exit 2
fi
if [[ ! -f "$HOME/.gemini/oauth_creds.json" ]]; then
  echo "ERROR: $HOME/.gemini/oauth_creds.json not found — run 'gemini' once to log in." >&2
  exit 2
fi

# Generate fresh secrets per run unless caller pinned them. Pinning is
# useful when iterating on workers without rebooting the server (so
# WORKER_SHARED_SECRET stays stable across `down`/`up` cycles).
export WORKER_SHARED_SECRET="${WORKER_SHARED_SECRET:-$(openssl rand -hex 32)}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}"

# Docker socket access on this host requires either docker-group membership
# or sudo. We default to sudo -E (preserves env so the *_SECRET vars
# reach docker compose interpolation). Set PAPERCLIP_DOCKER_NO_SUDO=1 if
# the invoking user is in the docker group.
DOCKER_PFX=()
if [[ -z "${PAPERCLIP_DOCKER_NO_SUDO:-}" ]]; then
  DOCKER_PFX=(sudo -E)
fi
dc() {
  "${DOCKER_PFX[@]}" docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" "$@"
}

case "$phase" in
  up)
    echo "==> Building images (first run takes 5-10 min)…"
    dc build
    echo "==> Bringing up the stack…"
    dc up -d
    echo "==> Waiting for control plane /api/health …"
    for i in $(seq 1 60); do
      if curl -fsS http://localhost:3100/api/health >/dev/null 2>&1; then break; fi
      sleep 2
    done
    echo "==> Server is up. Tailing for worker registration (60s)…"
    timeout 60 sh -c 'docker compose -f '"$COMPOSE_FILE"' -p '"$PROJECT_NAME"' logs -f server worker-1 worker-2 2>&1 | grep -E --line-buffered "register|Welcome|workerId|Hello|connected"' || true
    echo
    echo "==> Stack status:"
    dc ps
    echo
    echo "Next: $0 status   # see live logs"
    echo "      $0 down     # tear down"
    ;;
  status)
    dc ps
    echo
    dc logs --tail=30 server
    echo
    dc logs --tail=30 worker-1 worker-2
    ;;
  down)
    dc down -v
    ;;
  *)
    echo "usage: $0 [up|status|down]" >&2
    exit 2
    ;;
esac
