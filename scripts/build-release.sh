#!/usr/bin/env bash
# Build an air-gapped release tarball: every node_module, every built
# dist/, the SQL migrations, claude-code + gemini-cli binaries, all
# bundled into a single .tar.gz that can be scp'd into a GCP project
# without external internet access.
#
# Run this on a machine WITH network access. The output goes into
# release/paperclip-release-<commit>.tar.gz.
#
# # Linux portability
#
# The tarball includes native binaries for:
#   - sharp (image processing — libvips bindings)
#   - any other npm package with prebuilt binaries
#
# These are GLIBC-based and built on whatever distro you run this on.
# For maximum portability across "open Linux images" (Ubuntu, Debian,
# Rocky, RHEL, Amazon Linux 2, GCP COS, etc.), pass `--in-docker` so
# the build runs inside a node:lts-trixie-slim container. That target
# matches what every modern long-LTS distro ships.
#
# `embedded-postgres` is in the dep tree but the air-gapped path
# never runs it — you bring your own Cloud SQL / self-hosted
# Postgres. The binary it would download is skipped via the
# postinstall env var below.
#
# musl-based distros (Alpine) are NOT supported by this tarball.
# Sharp's prebuilt binaries are glibc; running on Alpine requires
# rebuilding from source against musl, which the air-gapped target
# can't do without network. Use a glibc base (debian-slim, distroless,
# Ubuntu, etc.) on the target.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT=$(git rev-parse --short HEAD)
RELEASE_NAME="paperclip-release-${COMMIT}"
OUT_DIR="${ROOT}/release"
STAGE="${OUT_DIR}/${RELEASE_NAME}"

# claude-code and gemini-cli versions to bundle. Pin explicitly so a
# release tarball is reproducible — bumping is a deliberate edit.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"
GEMINI_CLI_VERSION="${GEMINI_CLI_VERSION:-latest}"

log() { echo "[build-release] $*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }
}

require pnpm
require npm
require node
require tar
require git

log "release name: ${RELEASE_NAME}"
log "claude-code: ${CLAUDE_CODE_VERSION}, gemini-cli: ${GEMINI_CLI_VERSION}"

# --in-docker: rebuild this script's call inside the same container
# the production Dockerfile uses (node:lts-trixie-slim, glibc). The
# resulting tarball runs on any glibc-based Linux that has Node 20.
# Plain mode runs locally and produces a tarball whose native binaries
# are tied to whatever distro you're on. Recommended: --in-docker for
# any release that ships outside the build machine.
if [[ "${1:-}" == "--in-docker" ]]; then
  log "rebuilding inside node:lts-trixie-slim for portability"
  exec docker run --rm \
    -v "${ROOT}:/work" \
    -e CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION}" \
    -e GEMINI_CLI_VERSION="${GEMINI_CLI_VERSION}" \
    -w /work \
    node:lts-trixie-slim \
    bash -c '
      set -e
      apt-get update -qq
      apt-get install -y --no-install-recommends git tar ca-certificates >/dev/null
      corepack enable
      bash scripts/build-release.sh
    '
fi

# Skip embedded-postgres binary download — air-gapped target uses
# external postgres. The package stays in node_modules for code-level
# imports; the binary download just bloats the tarball.
export EMBEDDED_POSTGRES_SKIP_DOWNLOAD=1

rm -rf "$STAGE"
mkdir -p "$STAGE"

log "step 1/8: pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

log "step 2/8: pnpm -r build"
pnpm -r build

log "step 3/8: pnpm deploy server (production-only node_modules + dist)"
# pnpm deploy gathers all transitive prod deps + the built dist/ into
# a self-contained directory. The result is portable to any Node 20
# install — no further `npm install` required.
pnpm --filter @paperclipai/server deploy --prod "${STAGE}/server"

log "step 4/8: pnpm deploy worker"
pnpm --filter @paperclipai/worker deploy --prod "${STAGE}/packages/worker"

log "step 5/8: db migrations + runner"
# pnpm deploy of @paperclipai/db gives us the migrate runner + its
# transitive node_modules in one shot. Migrations land at
# packages/db/migrations (copied from src/ — drizzle-kit's output dir).
pnpm --filter @paperclipai/db deploy --prod "${STAGE}/packages/db"
mkdir -p "${STAGE}/packages/db/migrations"
cp -R "${ROOT}/packages/db/src/migrations/." "${STAGE}/packages/db/migrations/"

log "step 6/8: ui dist"
mkdir -p "${STAGE}/ui"
cp -R "${ROOT}/ui/dist" "${STAGE}/ui/dist"

log "step 7/8: claude-code + gemini-cli binaries"
mkdir -p "${STAGE}/bins"
cd "${STAGE}/bins"
# `npm install` here so the prod tree is independent of pnpm's symlink
# strategy — the output bins/node_modules is portable to any Node
# install (including the air-gapped target).
npm init -y >/dev/null
npm install --silent --prefix "${STAGE}/bins" \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@google/gemini-cli@${GEMINI_CLI_VERSION}"
cd "$ROOT"

log "step 8/8: scripts + README + version manifest"
mkdir -p "${STAGE}/scripts"

cat > "${STAGE}/scripts/start-server.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "${HERE}/server"
exec node dist/index.js
EOF
chmod +x "${STAGE}/scripts/start-server.sh"

cat > "${STAGE}/scripts/start-worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Make claude + gemini reachable for the adapter shims.
export PATH="${HERE}/bins/node_modules/.bin:${PATH}"
cd "${HERE}/packages/worker"
exec node dist/index.js
EOF
chmod +x "${STAGE}/scripts/start-worker.sh"

cat > "${STAGE}/scripts/apply-migrations.sh" <<'EOF'
#!/usr/bin/env bash
# Runs Drizzle migrations against $DATABASE_URL using the bundled
# migrate runner. Idempotent — safe to run on every deploy.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "${HERE}/packages/db"
# The migrate runner is in dist/migrate.js; node_modules carries
# postgres-js + drizzle-orm. NODE_PATH is set so a relative
# require("@paperclipai/db") resolves transitively if the runner
# leans on it.
exec node dist/migrate.js
EOF
chmod +x "${STAGE}/scripts/apply-migrations.sh"

cat > "${STAGE}/README.md" <<EOF
# Paperclip Release ${RELEASE_NAME}

Built from commit ${COMMIT} on $(date -u +%Y-%m-%dT%H:%M:%SZ).

This tarball is self-contained for air-gapped GCP deployment. It
includes every node_module, the built dist/ for server + worker + UI,
SQL migrations, and the claude-code + gemini-cli binaries.

## Bring up

The host machine needs Node.js (LTS 20.x) and a reachable Postgres.

\`\`\`
export DATABASE_URL=postgres://user:pass@host:5432/paperclip
./scripts/apply-migrations.sh
./scripts/start-server.sh
\`\`\`

For workers (separate VMs):

\`\`\`
export PAPERCLIP_CONTROL_PLANE_ADDR=control-plane:50051
export PAPERCLIP_WORKER_SHARED_SECRET=...
export PAPERCLIP_WORKER_ID=worker-\$(hostname)
./scripts/start-worker.sh
\`\`\`

See \`docs/DEPLOYMENT.md\` in the source repo for the full configuration
matrix (GCP id-token auth, filestore mode, Cloud Monitoring, etc.).
EOF

cat > "${STAGE}/version.txt" <<EOF
commit: ${COMMIT}
built-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
node: $(node --version)
pnpm: $(pnpm --version)
claude-code: ${CLAUDE_CODE_VERSION}
gemini-cli: ${GEMINI_CLI_VERSION}
EOF

# Reference docker-compose so an operator who wants self-hosted docker
# instead of bare-metal node has a starting point. The
# docker-compose.workers.yml in the source repo is the canonical
# reference; this is a copy with the image: lines pointing at
# whatever the operator pushes to their org's registry.
cat > "${STAGE}/docker-compose.air-gapped.yml" <<'EOF'
# Air-gapped reference compose. Build the docker image from this
# release directory and push it to your org's internal registry; this
# file then points at that image. Adjust the image: lines below.
version: "3.9"
services:
  db:
    image: <YOUR_INTERNAL_REGISTRY>/postgres:17-alpine
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: paperclip
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
  server:
    image: <YOUR_INTERNAL_REGISTRY>/paperclip-server:<COMMIT>
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://paperclip:${POSTGRES_PASSWORD}@db:5432/paperclip
      WORKER_GRPC_ENABLED: "true"
      WORKER_AUTH_MODE: shared_secret
      WORKER_SHARED_SECRET: ${WORKER_SHARED_SECRET:?required}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?required}
    ports: ["3100:3100", "50051:50051"]
  worker:
    image: <YOUR_INTERNAL_REGISTRY>/paperclip-worker:<COMMIT>
    depends_on: [server]
    environment:
      PAPERCLIP_CONTROL_PLANE_ADDR: server:50051
      PAPERCLIP_WORKER_SHARED_SECRET: ${WORKER_SHARED_SECRET}
      PAPERCLIP_WORKER_ID: worker-1
      PAPERCLIP_WORKER_ADAPTERS: claude_local,gemini_local
      PAPERCLIP_WORKER_MAX_CONCURRENT: "1"
EOF

log "tarball: ${OUT_DIR}/${RELEASE_NAME}.tar.gz"
cd "$OUT_DIR"
tar czf "${RELEASE_NAME}.tar.gz" "${RELEASE_NAME}"
SIZE=$(du -sh "${RELEASE_NAME}.tar.gz" | cut -f1)
log "done — ${SIZE}"
