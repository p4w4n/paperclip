# Deployment Guide

This guide covers deploying paperclip in two shapes:

1. **Single-host** (the default OSS install) — one server process, embedded postgres, ephemeral workspaces, no separate workers. Use this for solo operators and small teams.
2. **Distributed** (the worker plan, Phases 1-5) — separate control plane + worker fleet, claude_local and gemini_local runs dispatched to workers, GCP Filestore for shared workspaces, MIG autoscaler driven by a Cloud Monitoring custom metric. Use this for production GCP deployments at scale.

Air-gapped GCP deployments are supported via the release tarball produced by `scripts/build-release.sh` — see [Air-gapped GCP deployment](#air-gapped-gcp-deployment) below.

---

## Single-host

`pnpm onboard` walks through the configuration interactively. The defaults — embedded postgres + local-disk storage + ephemeral workspaces — work out of the box.

Distributed-workers feature flags stay off by default, so the single-host path is unaffected by anything in this guide.

---

## Distributed (control-plane + workers)

### Architecture

The control plane is a normal paperclip server with `WORKER_GRPC_ENABLED=true`. It listens on two ports:

- `3100` — HTTP API + UI
- `50051` — gRPC for the `Worker.Connect` bidi stream + `FetchSecrets` unary RPC

Workers are separate Node processes (`packages/worker/dist/index.js`) that dial `controlPlaneAddress:50051`, send `Hello`, and receive `RunDispatch` frames as the dispatcher routes runs to them. Workers run the adapter binaries (`claude`, `gemini`) locally — they need network access to the model provider APIs (Anthropic, Google), and they need the host's OAuth credential dirs (`~/.claude`, `~/.gemini`) mounted in if you're using subscription-based auth instead of API keys.

### Required configuration

**Control plane** (`server/`):

```
WORKER_GRPC_ENABLED=true
WORKER_AUTH_MODE=shared_secret              # or "gcp_id_token" for GCP-attested workers
WORKER_SHARED_SECRET=<random hex 32 bytes>  # required when shared_secret
WORKER_GCP_AUDIENCE=https://paperclip/workers # required when gcp_id_token
WORKER_GCP_SA_ALLOWLIST=worker-sa@proj.iam.gserviceaccount.com  # required when gcp_id_token
WORKER_GRPC_BIND_ADDRESS=0.0.0.0:50051
WORKER_LEASE_MAX_ATTEMPTS=2                  # 1 to disable auto-replay; default 2

# Filestore mode (Plan 4) — opt-in per project
PAPERCLIP_FILESTORE_ROOT=/mnt/paperclip-filestore  # path mounted on every worker

# Cloud Monitoring (Plan 5) — opt-in
PAPERCLIP_GCP_MONITORING_ENABLED=true
PAPERCLIP_GCP_PROJECT=my-gcp-project

# Storage (Plan 5) — opt-in
PAPERCLIP_STORAGE_PROVIDER=gcs               # or "local_disk", "s3"
PAPERCLIP_STORAGE_GCS_BUCKET=paperclip-blobs
```

**Worker** (`packages/worker/`):

```
PAPERCLIP_CONTROL_PLANE_ADDR=control-plane-host:50051
PAPERCLIP_WORKER_AUTH_MODE=shared_secret     # or "gcp_id_token"
PAPERCLIP_WORKER_SHARED_SECRET=<same as server>
PAPERCLIP_WORKER_AUDIENCE=https://paperclip/workers  # when gcp_id_token
PAPERCLIP_WORKER_ID=worker-${INSTANCE_ID}    # durable across worker process restarts
PAPERCLIP_WORKER_ADAPTERS=claude_local,gemini_local
PAPERCLIP_WORKER_MAX_CONCURRENT=1
PAPERCLIP_FILESTORE_ROOT=/mnt/paperclip-filestore  # same path as control plane
HOME=/paperclip                              # so claude-code / gemini-cli find their creds
```

### Bring up locally with docker compose

`docker/docker-compose.workers.yml` is a working multi-container reference:

```bash
export WORKER_SHARED_SECRET=$(openssl rand -hex 32)
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
sudo docker compose -f docker/docker-compose.workers.yml -p paperclip-workers up -d --build

# Server: http://localhost:23100
# Workers: 2 connected; each sees /paperclip/.claude and /paperclip/.gemini mounted ro from host
# Verify: sudo docker compose -f docker/docker-compose.workers.yml -p paperclip-workers logs server | grep "registered"
```

### GCP production deployment

Two GCE Managed Instance Groups (MIGs):

1. **Control plane** — single instance behind a load balancer; runs paperclip server with `WORKER_GRPC_ENABLED=true`, `WORKER_AUTH_MODE=gcp_id_token`. Postgres is Cloud SQL.
2. **Worker fleet** — autoscaling MIG; each instance runs `paperclip-worker` configured with `PAPERCLIP_WORKER_AUTH_MODE=gcp_id_token`. The MIG's autoscaler subscribes to the custom metric `custom.googleapis.com/paperclip/queue_depth` published by the control plane (Plan 5).

Filestore: GCP Filestore mounted at `/mnt/paperclip-filestore` on every instance (control plane + every worker). Per-project `filestore_mode=on` enables the shared-workspace path.

GCS: a bucket per deployment for session/artifact blobs (`PAPERCLIP_STORAGE_PROVIDER=gcs`).

MIG drain: when GCE rolling updates SIGTERM a worker, the worker's drain gate (Plan 2 Task 6) finishes in-flight runs and ends the stream cleanly. The control plane's lease reaper picks up anything that doesn't drain in time.

---

## Air-gapped GCP deployment

If your GCP project blocks external internet access (no npm, no pypi, no public registries), use the release tarball produced by `scripts/build-release.sh`. It bundles every node_module, the built dist/ for server + worker + ui, the SQL migrations, and the claude-code + gemini-cli binaries.

### Building the release tarball (on a machine with network)

```bash
./scripts/build-release.sh
# → release/paperclip-release-<commit>.tar.gz
```

The script:
1. Runs `pnpm install` + `pnpm -r build`
2. Uses `pnpm deploy` to gather production-only `node_modules` for `@paperclipai/server` and `@paperclipai/worker`
3. Installs `@anthropic-ai/claude-code` and `@google/gemini-cli` into a `bins/` dir
4. Bundles built UI assets, db migrations, db migration runner, deployment scripts, and a README
5. Produces a single tarball ready to scp into the air-gapped environment

### Deploying inside the air-gapped environment

The target machine needs only:
- Node.js (any LTS in the 20.x range; the build target is 20)
- A reachable Postgres (Cloud SQL or self-hosted; the embedded postgres path is not used here)

```bash
# On the air-gapped GCE instance:
tar xzf paperclip-release-<commit>.tar.gz
cd paperclip-release-<commit>

export DATABASE_URL=postgres://...
export WORKER_GRPC_ENABLED=true
export WORKER_AUTH_MODE=gcp_id_token        # or shared_secret with WORKER_SHARED_SECRET
export WORKER_GCP_AUDIENCE=https://paperclip/workers
export WORKER_GCP_SA_ALLOWLIST=worker-sa@proj.iam.gserviceaccount.com
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export PAPERCLIP_FILESTORE_ROOT=/mnt/paperclip-filestore   # if using Plan 4 filestore mode

./scripts/apply-migrations.sh                # applies SQL migrations against $DATABASE_URL
./scripts/start-server.sh                    # starts the control plane
```

For workers (separate VMs):

```bash
tar xzf paperclip-release-<commit>.tar.gz
cd paperclip-release-<commit>

export PAPERCLIP_CONTROL_PLANE_ADDR=control-plane-internal:50051
export PAPERCLIP_WORKER_AUTH_MODE=gcp_id_token
export PAPERCLIP_WORKER_AUDIENCE=https://paperclip/workers
export PAPERCLIP_WORKER_ID=worker-$(hostname)
export PAPERCLIP_WORKER_ADAPTERS=claude_local,gemini_local
export PATH="$PWD/bins/node_modules/.bin:$PATH"   # claude + gemini binaries

./scripts/start-worker.sh
```

### What's bundled in the tarball

```
paperclip-release-<commit>/
├── README.md                               (this file's relevant sections)
├── version.txt
├── server/
│   ├── dist/                               (built control plane)
│   ├── node_modules/                       (production-only, hoisted)
│   └── package.json
├── packages/worker/
│   ├── dist/                               (built worker binary)
│   ├── node_modules/
│   └── package.json
├── packages/db/
│   ├── dist/migrate.js
│   ├── migrations/                         (SQL files; apply with the runner)
│   └── package.json
├── ui/dist/                                (built UI assets; the server serves them)
├── bins/
│   └── node_modules/
│       ├── @anthropic-ai/claude-code/
│       ├── @google/gemini-cli/
│       └── .bin/{claude,gemini}            (PATH these for adapter execution)
├── scripts/
│   ├── start-server.sh
│   ├── start-worker.sh
│   └── apply-migrations.sh
└── docker-compose.air-gapped.yml           (reference compose for self-hosted docker)
```

### What the tarball does NOT include

- **Postgres.** Bring your own Cloud SQL or self-hosted instance; set `DATABASE_URL`.
- **TLS certs / load balancer config.** Out of scope; deployment-specific.
- **Adapter API keys / OAuth tokens.** Mount `~/.claude` and `~/.gemini` from a host with logged-in credentials, OR set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.
- **GCP Filestore / GCS bucket provisioning.** Use Terraform or `gcloud` to create them; the tarball just consumes them.

---

## Troubleshooting

**Workers connect but immediately disconnect.** Check that `WORKER_SHARED_SECRET` matches between server and worker. Mismatched auth surfaces as a stream-end with no clear log on the worker side.

**Lease reaper logs `lease reaper sweep failed`.** Usually a transient DB blip; the next 30s tick retries. If persistent, check the heartbeat_runs table indexes — the reaper queries `WHERE status IN ('running','pending_run') AND lease_expires_at < now()`.

**`workspace_busy` errors when filestore_mode is on.** Expected when two runs target the same workspace concurrently — the heartbeat scheduler retries on its next tick automatically. If a workspace stays busy indefinitely, look for a stuck lease via `SELECT * FROM workspace_leases WHERE released_at IS NULL` and the workspace-lease reaper logs.

**Cloud Monitoring metrics not appearing.** Verify `PAPERCLIP_GCP_MONITORING_ENABLED=true` and `PAPERCLIP_GCP_PROJECT` are set, and that `@google-cloud/monitoring` is installed (the lazy-import returns null when the package is absent — see `server/src/services/cloud-monitoring-publisher.ts`).
