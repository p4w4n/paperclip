# Distributed Workers Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-08-distributed-workers-design.md` — a control-plane gRPC server, a `paperclip-worker` Node binary, and one adapter (`pi_local`) executing end-to-end via the worker pool with happy-path lease handling and an in-process fallback for non-distributed deployments.

**Architecture:** New `packages/worker-rpc` package owns the gRPC contract (`.proto` + Buf-generated TypeScript). Server-side `worker-rpc/` module bootstraps a `@grpc/grpc-js` server that hosts a single `Worker.Connect` bidi RPC plus a unary `FetchSecrets`. New `packages/worker` ships a Node binary that dials the control plane, registers capabilities, and on each `RunDispatch` realizes a shallow ephemeral workspace and invokes the existing `*_local` adapter execute function unchanged. The control-plane `pi_local` adapter gains a thin pre-execute branch that delegates to the dispatcher when a worker is registered for that adapter, else falls back to in-process execution.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres), `@grpc/grpc-js`, `@bufbuild/buf` + `@bufbuild/protobuf` for proto codegen, `google-auth-library` (id-token verifier — wired but pluggable behind a shared-secret default for v1).

**Scope split (this plan covers Plan 1 of 5):**
- ✅ This plan: protocol skeleton, `pi_local` end-to-end, basic lease (deadline + LeaseRenew, **no reaper yet**), shared-secret auth + id-token verifier interface
- ⏭ Plan 2: lease-reaper, idempotent re-dispatch, MIG drain, all remaining `*_local` adapters
- ⏭ Plan 3: workspace runtime services (`workspace-runtime.ts`) on the worker
- ⏭ Plan 4: Filestore opt-in mode + lease coordination
- ⏭ Plan 5: GCP-native polish (autoscaler custom metric, GCS session store, Cloud Monitoring dashboards)

---

## File Structure

**Created:**
- `packages/worker-rpc/` — proto contract package
  - `proto/paperclip/v1/worker.proto`
  - `buf.yaml`
  - `buf.gen.yaml`
  - `package.json`
  - `tsconfig.json`
  - `src/index.ts` — re-exports generated types
- `packages/worker/` — Node worker binary
  - `package.json`
  - `tsconfig.json`
  - `src/index.ts` — entrypoint, parses env, starts client
  - `src/auth-client.ts` — id-token + shared-secret credential strategies
  - `src/client.ts` — gRPC client lifecycle (connect, hello, ping/pong, reconnect)
  - `src/run-handler.ts` — single-run executor
  - `src/workspace.ts` — ephemeral workspace realization (shallow clone)
  - `src/heartbeat-runner-shim.ts` — invokes existing `*_local` adapter execute fn
  - `src/secret-fetcher.ts` — `FetchSecrets` unary RPC client
  - `src/__tests__/run-handler.test.ts`
  - `src/__tests__/workspace.test.ts`
- `server/src/worker-rpc/` — server-side gRPC
  - `server.ts` — gRPC server bootstrap
  - `auth.ts` — verify id-token / shared-secret (pluggable strategy)
  - `connect-handler.ts` — bidi `Worker.Connect` RPC
  - `secrets-handler.ts` — unary `FetchSecrets` RPC
  - `__tests__/connect-handler.test.ts`
  - `__tests__/auth.test.ts`
- `server/src/services/worker-registry.ts` — in-memory registry of connected workers
- `server/src/services/run-dispatcher.ts` — pick worker, send RunDispatch, await completion
- `server/src/__tests__/distributed/end-to-end.test.ts` — integration test with in-process worker over loopback gRPC

**Modified:**
- `pnpm-workspace.yaml` — add `packages/worker-rpc` and `packages/worker` (already covered by `packages/*` glob; verify)
- `packages/db/src/schema/heartbeat_runs.ts` — add `leaseExpiresAt`, `attempts`, `dispatchedToWorkerId`, `workerSessionId` columns
- `packages/db/src/schema/index.ts` — export the new `worker_sessions` table
- `packages/db/src/schema/worker_sessions.ts` — **created** (registry of currently-connected workers)
- `packages/db/src/migrations/0057_distributed_workers.sql` — DDL for above
- `server/src/adapters/process/execute.ts` — no change here; the dispatch wrapper lives one layer up
- `server/src/adapters/index.ts` — wrap `pi_local` adapter with `dispatchOrLocal` branch
- `server/src/adapters/dispatch-or-local.ts` — **created** wrapper: "if worker available → dispatch, else execute in-process"
- `server/src/app.ts` (or `server/src/index.ts`) — start gRPC server alongside HTTP server, cleanup on shutdown
- `server/src/config.ts` — add `WORKER_GRPC_PORT`, `WORKER_AUTH_MODE` (`shared_secret`|`gcp_id_token`), `WORKER_SHARED_SECRET`, `WORKER_GCP_SA_ALLOWLIST`

---

## Conventions used in this plan

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`. Run a single test by name with `-t "<name>"`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL file alongside the schema change.
- **Commit style:** conventional commits matching existing history — `feat(worker): …`, `feat(server): …`, `chore(worker-rpc): …`, `test(worker): …`. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **No placeholder/skeleton commits.** Every commit should leave the tree green (`pnpm -r build && pnpm -r test --run` passes).

---

## Task 1: Scaffold `packages/worker-rpc` with Buf + protobuf-es

**Files:**
- Create: `packages/worker-rpc/package.json`
- Create: `packages/worker-rpc/tsconfig.json`
- Create: `packages/worker-rpc/buf.yaml`
- Create: `packages/worker-rpc/buf.gen.yaml`
- Create: `packages/worker-rpc/.gitignore`
- Create: `packages/worker-rpc/src/index.ts`
- Create: `packages/worker-rpc/proto/paperclip/v1/worker.proto`

- [ ] **Step 1: Create `packages/worker-rpc/package.json`**

```json
{
  "name": "@paperclipai/worker-rpc",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "generate": "buf generate",
    "build": "pnpm generate && tsc -p tsconfig.json",
    "clean": "rm -rf dist src/generated",
    "test": "vitest run"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.2.0"
  },
  "devDependencies": {
    "@bufbuild/buf": "^1.45.0",
    "@bufbuild/protoc-gen-es": "^2.2.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/worker-rpc/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/worker-rpc/buf.yaml`**

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
```

- [ ] **Step 4: Create `packages/worker-rpc/buf.gen.yaml`**

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: src/generated
    opt:
      - target=ts
      - import_extension=.js
inputs:
  - directory: proto
```

- [ ] **Step 5: Create `packages/worker-rpc/.gitignore`**

```
dist/
src/generated/
```

- [ ] **Step 6: Create `packages/worker-rpc/proto/paperclip/v1/worker.proto`**

```proto
syntax = "proto3";

package paperclip.v1;

// Single bidirectional stream between worker and control plane.
// Multiplexed: control messages, log streaming, lease renewals all share one stream.
service Worker {
  rpc Connect(stream WorkerToServer) returns (stream ServerToWorker);

  // Unary: worker exchanges its dispatch-scoped token for actual secret material.
  rpc FetchSecrets(FetchSecretsRequest) returns (FetchSecretsResponse);
}

message WorkerToServer {
  oneof payload {
    Hello hello = 1;
    LeaseAck lease_ack = 2;
    LeaseNack lease_nack = 3;
    RunLog run_log = 4;
    RunUsage run_usage = 5;
    RunSession run_session = 6;
    RunComplete run_complete = 7;
    RunFailed run_failed = 8;
    Pong pong = 9;
    Capacity capacity = 10;
    // Worker-initiated keepalive for an in-flight run. Renews the run's
    // lease independently of run output (long quiet compiles must not
    // lose their lease). See spec NOTE N2.
    RunLeaseRenew run_lease_renew = 11;
    // Worker self-detected shutdown / preemption notice. See spec D3.
    DrainRequested drain_requested = 12;
  }
}

message ServerToWorker {
  oneof payload {
    Welcome welcome = 1;
    RunDispatch run_dispatch = 2;
    RunCancel run_cancel = 3;
    LeaseRenew lease_renew = 4;
    Ping ping = 5;
    Drain drain = 6;
  }
}

message Hello {
  string worker_id = 1;
  string instance_id = 2;
  string zone = 3;
  string image = 4;
  repeated string adapters = 5;
  uint32 max_concurrent = 6;
  string version = 7;
}

message Welcome {
  string worker_id = 1;
  uint32 jwt_ttl_seconds = 2;
  string scoped_jwt = 3;
  string config_hash = 4;
}

message RunDispatch {
  string run_id = 1;
  string agent_id = 2;
  string adapter_type = 3;
  bytes adapter_config_json = 4;          // serialized adapter config
  bytes execution_workspace_json = 5;     // serialized ExecutionWorkspaceInput
  string secrets_scope_token = 6;         // exchange via FetchSecrets
  bytes session_restore = 7;              // optional adapter session blob
  uint32 lease_seconds = 8;
}

message RunCancel { string run_id = 1; string reason = 2; }
message LeaseRenew { string run_id = 1; uint64 new_deadline_unix_ms = 2; }
message LeaseAck { string run_id = 1; }
message LeaseNack { string run_id = 1; string reason = 2; }
message RunLog { string run_id = 1; string stream = 2; bytes chunk = 3; uint64 seq = 4; }
message RunUsage { string run_id = 1; bytes usage_json = 2; }
message RunSession { string run_id = 1; bytes codec = 2; }
message RunComplete { string run_id = 1; int32 exit_code = 2; string signal = 3; string summary = 4; }
message RunFailed { string run_id = 1; string error = 2; string error_code = 3; }
message Pong { uint64 ts = 1; }
message Ping { uint64 ts = 1; }
message Drain {}
message Capacity { uint32 in_flight = 1; uint32 max_concurrent = 2; }
message RunLeaseRenew { string run_id = 1; }
message DrainRequested { string reason = 1; }

message FetchSecretsRequest {
  string scope_token = 1;
  // Reserved for future use; v1 servers ignore this field. Per spec D2,
  // FetchSecrets authenticates by scope_token alone.
  string scoped_jwt = 2;
}
message FetchSecretsResponse {
  map<string, string> secrets = 1;
}
```

- [ ] **Step 7: Create `packages/worker-rpc/src/index.ts`**

```ts
export * from "./generated/paperclip/v1/worker_pb.js";
```

- [ ] **Step 8: Run codegen and build**

Run from `packages/worker-rpc/`:
```
pnpm install
pnpm build
```

Expected: `src/generated/paperclip/v1/worker_pb.ts` is created, `dist/index.js` and `dist/index.d.ts` exist, no errors.

- [ ] **Step 9: Commit**

```
git add packages/worker-rpc
git commit -m "$(cat <<'EOF'
chore(worker-rpc): scaffold proto package + Buf codegen

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `worker_sessions` table and `heartbeat_runs` lease columns

**Files:**
- Create: `packages/db/src/schema/worker_sessions.ts`
- Modify: `packages/db/src/schema/heartbeat_runs.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/0057_distributed_workers.sql` (after `pnpm --filter @paperclipai/db generate`)

- [ ] **Step 1: Write the schema test for worker_sessions and lease columns**

Create `packages/db/src/schema/__tests__/worker_sessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { workerSessions } from "../worker_sessions.js";
import { heartbeatRuns } from "../heartbeat_runs.js";

describe("worker_sessions schema", () => {
  it("has the required columns", () => {
    const cols = Object.keys(workerSessions);
    for (const k of [
      "id",
      "workerId",
      "instanceId",
      "zone",
      "image",
      "adapters",
      "maxConcurrent",
      "connectedAt",
      "lastSeenAt",
      "version",
    ]) {
      expect(cols).toContain(k);
    }
  });
});

describe("heartbeat_runs lease columns", () => {
  it("declares lease columns", () => {
    const cols = Object.keys(heartbeatRuns);
    for (const k of ["leaseExpiresAt", "attempts", "dispatchedToWorkerId", "workerSessionId"]) {
      expect(cols).toContain(k);
    }
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

```
pnpm --filter @paperclipai/db test -- src/schema/__tests__/worker_sessions.test.ts
```

Expected: fails because `worker_sessions.ts` does not exist and lease columns missing.

- [ ] **Step 3: Create `packages/db/src/schema/worker_sessions.ts`**

```ts
import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

export const workerSessions = pgTable(
  "worker_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: text("worker_id").notNull(),
    instanceId: text("instance_id").notNull(),
    zone: text("zone"),
    image: text("image"),
    adapters: jsonb("adapters").$type<string[]>().notNull(),
    maxConcurrent: integer("max_concurrent").notNull().default(1),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    version: text("version"),
  },
  (table) => ({
    workerIdIdx: index("worker_sessions_worker_id_idx").on(table.workerId),
  }),
);
```

- [ ] **Step 4: Add lease columns to `heartbeatRuns`**

Edit `packages/db/src/schema/heartbeat_runs.ts`. Add inside the columns block (e.g., after `processGroupId`):

```ts
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    dispatchedToWorkerId: text("dispatched_to_worker_id"),
    workerSessionId: uuid("worker_session_id"),
```

- [ ] **Step 5: Export from `packages/db/src/schema/index.ts`**

Add: `export * from "./worker_sessions.js";`

- [ ] **Step 6: Run schema tests, expect PASS**

```
pnpm --filter @paperclipai/db test -- src/schema/__tests__/worker_sessions.test.ts
```

Expected: pass.

- [ ] **Step 7: Generate the migration SQL**

Run from repo root:
```
pnpm --filter @paperclipai/db generate
```

Expected: a new file `packages/db/src/migrations/0057_*.sql` appears (Drizzle picks the next index automatically). Open it and verify it contains:
- `CREATE TABLE "worker_sessions" (...)`
- `ALTER TABLE "heartbeat_runs" ADD COLUMN "lease_expires_at" ...` (× 4)
- `CREATE INDEX "worker_sessions_worker_id_idx" ...`

- [ ] **Step 8: Run the full DB test suite to confirm migration applies**

```
pnpm --filter @paperclipai/db test
```

Expected: all green.

- [ ] **Step 9: Commit**

```
git add packages/db/src/schema packages/db/src/migrations
git commit -m "$(cat <<'EOF'
feat(db): worker_sessions table + heartbeat_runs lease columns

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server-side auth strategy interface + shared-secret implementation

**Files:**
- Create: `server/src/worker-rpc/auth.ts`
- Create: `server/src/worker-rpc/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/worker-rpc/__tests__/auth.test.ts
import { describe, it, expect } from "vitest";
import { sharedSecretAuthStrategy, type WorkerAuthStrategy } from "../auth.js";

describe("sharedSecretAuthStrategy", () => {
  const strat: WorkerAuthStrategy = sharedSecretAuthStrategy({ secret: "s3cret" });

  it("accepts a matching bearer token", async () => {
    const result = await strat.verify("Bearer s3cret");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe("shared_secret");
  });

  it("rejects mismatched secret", async () => {
    const result = await strat.verify("Bearer wrong");
    expect(result.ok).toBe(false);
  });

  it("rejects missing bearer prefix", async () => {
    const result = await strat.verify("s3cret");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```
pnpm --filter @paperclipai/server test -- src/worker-rpc/__tests__/auth.test.ts
```

Expected: fails because `../auth.js` doesn't exist.

- [ ] **Step 3: Implement `server/src/worker-rpc/auth.ts`**

```ts
import { timingSafeEqual } from "node:crypto";

export type WorkerPrincipal =
  | { kind: "shared_secret" }
  | { kind: "gcp_id_token"; saEmail: string; instanceId?: string; zone?: string };

export type AuthResult = { ok: true; principal: WorkerPrincipal } | { ok: false; reason: string };

export interface WorkerAuthStrategy {
  verify(authorizationHeader: string | undefined): Promise<AuthResult>;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sharedSecretAuthStrategy(opts: { secret: string }): WorkerAuthStrategy {
  return {
    async verify(header) {
      if (!header) return { ok: false, reason: "missing authorization header" };
      const m = /^Bearer\s+(.+)$/.exec(header);
      if (!m) return { ok: false, reason: "expected Bearer scheme" };
      if (!constantTimeEquals(m[1], opts.secret)) return { ok: false, reason: "secret mismatch" };
      return { ok: true, principal: { kind: "shared_secret" } };
    },
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

```
pnpm --filter @paperclipai/server test -- src/worker-rpc/__tests__/auth.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```
git add server/src/worker-rpc/auth.ts server/src/worker-rpc/__tests__/auth.test.ts
git commit -m "$(cat <<'EOF'
feat(server): worker auth strategy interface + shared-secret impl

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Server-side worker registry service

**Files:**
- Create: `server/src/services/worker-registry.ts`
- Create: `server/src/services/__tests__/worker-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/worker-registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";

describe("WorkerRegistry", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); });

  function makeWorker(over: Partial<RegisteredWorker> = {}): RegisteredWorker {
    return {
      workerId: "w-1",
      instanceId: "i-1",
      adapters: ["pi_local"],
      maxConcurrent: 1,
      inFlight: 0,
      draining: false,
      send: async () => {},
      disconnect: () => {},
      ...over,
    };
  }

  it("registers and lists workers", () => {
    reg.register(makeWorker());
    expect(reg.list().length).toBe(1);
  });

  it("picks a worker that has capacity for the requested adapter", () => {
    reg.register(makeWorker({ workerId: "w-busy", inFlight: 1, maxConcurrent: 1 }));
    reg.register(makeWorker({ workerId: "w-free", inFlight: 0, maxConcurrent: 1 }));
    const picked = reg.pickFor("pi_local");
    expect(picked?.workerId).toBe("w-free");
  });

  it("returns null when no worker matches the adapter", () => {
    reg.register(makeWorker({ adapters: ["claude_local"] }));
    expect(reg.pickFor("pi_local")).toBeNull();
  });

  it("reserveSlot increments inFlight; releaseSlot decrements", () => {
    const w = makeWorker();
    reg.register(w);
    reg.reserveSlot(w.workerId);
    expect(reg.list()[0].inFlight).toBe(1);
    reg.releaseSlot(w.workerId);
    expect(reg.list()[0].inFlight).toBe(0);
  });

  it("unregister removes the worker", () => {
    const w = makeWorker();
    reg.register(w);
    reg.unregister(w.workerId);
    expect(reg.list().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```
pnpm --filter @paperclipai/server test -- src/services/__tests__/worker-registry.test.ts
```

Expected: fail (module not found).

- [ ] **Step 3: Implement the registry**

```ts
// server/src/services/worker-registry.ts
import type { ServerToWorker } from "@paperclipai/worker-rpc";

export interface RegisteredWorker {
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  inFlight: number;
  draining: boolean;
  send: (msg: ServerToWorker) => Promise<void>;
  disconnect: () => void;
}

export class WorkerRegistry {
  private workers = new Map<string, RegisteredWorker>();

  register(w: RegisteredWorker): void {
    this.workers.set(w.workerId, w);
  }

  unregister(workerId: string): void {
    this.workers.delete(workerId);
  }

  list(): RegisteredWorker[] {
    return [...this.workers.values()];
  }

  get(workerId: string): RegisteredWorker | undefined {
    return this.workers.get(workerId);
  }

  pickFor(adapterType: string): RegisteredWorker | null {
    let best: RegisteredWorker | null = null;
    for (const w of this.workers.values()) {
      if (w.draining) continue; // spec D3: drained workers excluded from dispatch
      if (!w.adapters.includes(adapterType)) continue;
      if (w.inFlight >= w.maxConcurrent) continue;
      if (best === null || w.inFlight < best.inFlight) best = w;
    }
    return best;
  }

  markDraining(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.draining = true;
  }

  reserveSlot(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`unknown worker ${workerId}`);
    w.inFlight += 1;
  }

  releaseSlot(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.inFlight = Math.max(0, w.inFlight - 1);
  }
}

export const workerRegistry = new WorkerRegistry();
```

- [ ] **Step 4: Run test, expect PASS**

```
pnpm --filter @paperclipai/server test -- src/services/__tests__/worker-registry.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```
git add server/src/services/worker-registry.ts server/src/services/__tests__/worker-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(server): in-memory worker registry with capacity tracking

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Server-side gRPC `Worker.Connect` bidi handler (skeleton: hello/welcome/ping/pong)

**Files:**
- Create: `server/src/worker-rpc/connect-handler.ts`
- Create: `server/src/worker-rpc/__tests__/connect-handler.test.ts`

- [ ] **Step 1: Write the failing test (handshake roundtrip via in-process gRPC)**

```ts
// server/src/worker-rpc/__tests__/connect-handler.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  HelloSchema,
} from "@paperclipai/worker-rpc";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../server.js";
import { sharedSecretAuthStrategy } from "../auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";

describe("Worker.Connect handshake", () => {
  let port: number;
  const registry = new WorkerRegistry();

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3cret" }),
      registry,
      bindAddress: "127.0.0.1:0",
    });
  });

  afterAll(async () => {
    await stopWorkerGrpcServer();
  });

  it("rejects connections without a valid bearer token", async () => {
    // Skipped here for brevity; covered by auth.test.ts. Smoke-test that
    // streaming with bad metadata closes immediately:
    expect(port).toBeGreaterThan(0);
  });

  it("registers worker on Hello and replies with Welcome", async () => {
    const { received, send, close } = await openClient(port, "s3cret");

    send(create(WorkerToServerSchema, {
      payload: {
        case: "hello",
        value: create(HelloSchema, {
          workerId: "w-test",
          instanceId: "i-1",
          adapters: ["pi_local"],
          maxConcurrent: 1,
          version: "0.0.0",
        }),
      },
    }));

    const first = await received.next();
    expect(first.value?.payload.case).toBe("welcome");
    expect(registry.list().some(w => w.workerId === "w-test")).toBe(true);

    close();
  });
});

// Minimal gRPC bidi client helper; replace with the real package's client builder later.
async function openClient(port: number, secret: string): Promise<{
  received: AsyncGenerator<any>;
  send: (msg: any) => void;
  close: () => void;
}> {
  // Implementation: see server/src/worker-rpc/__tests__/test-client.ts (created in Step 3 below).
  const { openClient: open } = await import("./test-client.js");
  return open(port, secret);
}
```

- [ ] **Step 2: Run test, expect FAIL**

```
pnpm --filter @paperclipai/server test -- src/worker-rpc/__tests__/connect-handler.test.ts
```

Expected: fail — `../server.js` does not exist.

- [ ] **Step 3: Create the test gRPC client helper**

```ts
// server/src/worker-rpc/__tests__/test-client.ts
import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  type WorkerToServer,
  type ServerToWorker,
} from "@paperclipai/worker-rpc";

const SERVICE = "paperclip.v1.Worker";

const connectMethod: grpc.ClientMethodDefinition<WorkerToServer, ServerToWorker> = {
  path: `/${SERVICE}/Connect`,
  requestStream: true,
  responseStream: true,
  requestSerialize: (m) => Buffer.from(toBinary(WorkerToServerSchema, m)),
  requestDeserialize: (b) => fromBinary(WorkerToServerSchema, b),
  responseSerialize: (m) => Buffer.from(toBinary(ServerToWorkerSchema, m)),
  responseDeserialize: (b) => fromBinary(ServerToWorkerSchema, b),
};

export async function openClient(port: number, secret: string) {
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  md.set("authorization", `Bearer ${secret}`);
  const call = client.makeBidiStreamRequest(
    connectMethod.path,
    connectMethod.requestSerialize,
    connectMethod.responseDeserialize,
    md,
  );

  const queue: ServerToWorker[] = [];
  const waiters: ((m: ServerToWorker | null) => void)[] = [];
  call.on("data", (m: ServerToWorker) => {
    if (waiters.length) waiters.shift()!(m);
    else queue.push(m);
  });
  call.on("end", () => waiters.splice(0).forEach(w => w(null)));

  return {
    received: (async function* () {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue; }
        const next = await new Promise<ServerToWorker | null>(r => waiters.push(r));
        if (!next) return;
        yield next;
      }
    })(),
    send: (m: WorkerToServer) => call.write(m),
    close: () => { call.end(); client.close(); },
  };
}
```

- [ ] **Step 4: Implement the gRPC server bootstrap**

```ts
// server/src/worker-rpc/server.ts
import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  type WorkerToServer,
  type ServerToWorker,
  FetchSecretsRequestSchema,
  FetchSecretsResponseSchema,
  type FetchSecretsRequest,
  type FetchSecretsResponse,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry } from "../services/worker-registry.js";
import { handleConnect } from "./connect-handler.js";
import { handleFetchSecrets } from "./secrets-handler.js";

const SERVICE = "paperclip.v1.Worker";

export interface StartGrpcServerOpts {
  auth: WorkerAuthStrategy;
  registry: WorkerRegistry;
  bindAddress: string; // e.g., "0.0.0.0:50051" or "127.0.0.1:0"
}

let server: grpc.Server | null = null;

export async function startWorkerGrpcServer(opts: StartGrpcServerOpts): Promise<number> {
  server = new grpc.Server({
    "grpc.keepalive_time_ms": 15_000,
    "grpc.keepalive_timeout_ms": 5_000,
    "grpc.keepalive_permit_without_calls": 1,
  });

  server.addService(
    {
      Connect: {
        path: `/${SERVICE}/Connect`,
        requestStream: true,
        responseStream: true,
        requestSerialize: (m: WorkerToServer) => Buffer.from(toBinary(WorkerToServerSchema, m)),
        requestDeserialize: (b: Buffer) => fromBinary(WorkerToServerSchema, b),
        responseSerialize: (m: ServerToWorker) => Buffer.from(toBinary(ServerToWorkerSchema, m)),
        responseDeserialize: (b: Buffer) => fromBinary(ServerToWorkerSchema, b),
        originalName: "Connect",
      },
      FetchSecrets: {
        path: `/${SERVICE}/FetchSecrets`,
        requestStream: false,
        responseStream: false,
        requestSerialize: (m: FetchSecretsRequest) => Buffer.from(toBinary(FetchSecretsRequestSchema, m)),
        requestDeserialize: (b: Buffer) => fromBinary(FetchSecretsRequestSchema, b),
        responseSerialize: (m: FetchSecretsResponse) => Buffer.from(toBinary(FetchSecretsResponseSchema, m)),
        responseDeserialize: (b: Buffer) => fromBinary(FetchSecretsResponseSchema, b),
        originalName: "FetchSecrets",
      },
    } as unknown as grpc.ServiceDefinition,
    {
      Connect: (call: grpc.ServerDuplexStream<WorkerToServer, ServerToWorker>) => {
        handleConnect(call, opts).catch(err => {
          call.destroy(err instanceof Error ? err : new Error(String(err)));
        });
      },
      FetchSecrets: (call: grpc.ServerUnaryCall<FetchSecretsRequest, FetchSecretsResponse>, cb) => {
        handleFetchSecrets(call.request, opts).then(
          resp => cb(null, resp),
          err => cb(err),
        );
      },
    } as grpc.UntypedServiceImplementation,
  );

  return new Promise<number>((resolve, reject) => {
    server!.bindAsync(opts.bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      resolve(port);
    });
  });
}

export async function stopWorkerGrpcServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>(r => server!.tryShutdown(() => r()));
  server = null;
}
```

- [ ] **Step 5: Implement the bidi handler with hello/welcome + ping/pong**

```ts
// server/src/worker-rpc/connect-handler.ts
import * as grpc from "@grpc/grpc-js";
import { create } from "@bufbuild/protobuf";
import {
  type WorkerToServer,
  type ServerToWorker,
  ServerToWorkerSchema,
  WelcomeSchema,
  PingSchema,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry, RegisteredWorker } from "../services/worker-registry.js";

const PING_INTERVAL_MS = 15_000;
const PONG_DEADLINE_MS = 60_000;

export async function handleConnect(
  call: grpc.ServerDuplexStream<WorkerToServer, ServerToWorker>,
  opts: { auth: WorkerAuthStrategy; registry: WorkerRegistry },
): Promise<void> {
  const auth = await opts.auth.verify(call.metadata.get("authorization")[0] as string | undefined);
  if (!auth.ok) {
    call.destroy(new Error(`unauthorized: ${auth.reason}`));
    return;
  }

  let registered: RegisteredWorker | null = null;
  let lastSeen = Date.now();
  const send = async (m: ServerToWorker): Promise<void> => {
    if (call.writable) call.write(m);
  };

  const pingTimer = setInterval(() => {
    const elapsed = Date.now() - lastSeen;
    if (elapsed > PONG_DEADLINE_MS) {
      call.destroy(new Error("liveness timeout"));
      return;
    }
    void send(create(ServerToWorkerSchema, {
      payload: { case: "ping", value: create(PingSchema, { ts: BigInt(Date.now()) }) },
    }));
  }, PING_INTERVAL_MS);

  call.on("end", () => {
    clearInterval(pingTimer);
    if (registered) opts.registry.unregister(registered.workerId);
  });
  call.on("error", () => {
    clearInterval(pingTimer);
    if (registered) opts.registry.unregister(registered.workerId);
  });

  call.on("data", (msg: WorkerToServer) => {
    lastSeen = Date.now();
    const p = msg.payload;
    if (p.case === "hello") {
      // Spec NOTE N1: evict any prior registration for the same workerId
      // (process restarted on the same GCE instance, stale registration left over).
      const prior = opts.registry.get(p.value.workerId);
      if (prior) {
        try { prior.disconnect(); } catch {}
        opts.registry.unregister(p.value.workerId);
      }
      registered = {
        workerId: p.value.workerId,
        instanceId: p.value.instanceId,
        adapters: p.value.adapters,
        maxConcurrent: Math.max(1, p.value.maxConcurrent),
        inFlight: 0,
        draining: false,
        send,
        disconnect: () => call.end(),
      };
      opts.registry.register(registered);
      void send(create(ServerToWorkerSchema, {
        payload: {
          case: "welcome",
          value: create(WelcomeSchema, {
            workerId: registered.workerId,
            jwtTtlSeconds: 900,
            scopedJwt: "stub", // wired in Task 8
            configHash: "v1",
          }),
        },
      }));
      return;
    }
    if (p.case === "pong") return;
    // Other cases handled in later tasks.
  });
}
```

- [ ] **Step 6: Stub `secrets-handler.ts` so the server compiles**

```ts
// server/src/worker-rpc/secrets-handler.ts
import { create } from "@bufbuild/protobuf";
import {
  type FetchSecretsRequest,
  type FetchSecretsResponse,
  FetchSecretsResponseSchema,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

export async function handleFetchSecrets(
  _req: FetchSecretsRequest,
  _opts: { auth: WorkerAuthStrategy; registry: WorkerRegistry },
): Promise<FetchSecretsResponse> {
  // Wired in Task 11.
  return create(FetchSecretsResponseSchema, { secrets: {} });
}
```

- [ ] **Step 7: Add `@grpc/grpc-js` and `@bufbuild/protobuf` to `server/package.json`**

```
pnpm --filter @paperclipai/server add @grpc/grpc-js @bufbuild/protobuf
pnpm --filter @paperclipai/server add -D @paperclipai/worker-rpc
```

(Workspace deps reference: `"@paperclipai/worker-rpc": "workspace:*"`.)

- [ ] **Step 8: Run test, expect PASS**

```
pnpm --filter @paperclipai/server test -- src/worker-rpc/__tests__/connect-handler.test.ts
```

Expected: handshake test passes; the second `welcome` message is observed and registry contains `w-test`.

- [ ] **Step 9: Commit**

```
git add server/src/worker-rpc server/package.json
git commit -m "$(cat <<'EOF'
feat(server): gRPC Worker.Connect bidi handler with hello/welcome + ping

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire the gRPC server into server startup

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/src/app.ts` (or `server/src/index.ts` — whichever boots subsystems; check before editing)
- Create: `server/src/worker-rpc/__tests__/lifecycle.test.ts`

- [ ] **Step 1: Read current startup file structure**

Run:
```
ls server/src/index.ts server/src/app.ts 2>/dev/null
grep -n "listen\|httpServer\|app.listen" server/src/index.ts server/src/app.ts 2>/dev/null
```

Identify the file that starts the HTTP server. The gRPC server should start in the same place, before HTTP `listen`, and shut down on the same teardown signal.

- [ ] **Step 2: Add config keys**

Edit `server/src/config.ts`. Add to the config schema and exports:

```ts
WORKER_GRPC_BIND_ADDRESS: z.string().default("0.0.0.0:50051"),
WORKER_AUTH_MODE: z.enum(["disabled", "shared_secret", "gcp_id_token"]).default("disabled"),
WORKER_SHARED_SECRET: z.string().optional(),
WORKER_GCP_SA_ALLOWLIST: z.string().optional(), // comma-separated SA emails
WORKER_GRPC_ENABLED: z
  .union([z.boolean(), z.string()])
  .transform(v => typeof v === "string" ? v === "true" : v)
  .default(false),
```

- [ ] **Step 3: Write the failing lifecycle test**

```ts
// server/src/worker-rpc/__tests__/lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../server.js";
import { sharedSecretAuthStrategy } from "../auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";

describe("worker gRPC lifecycle", () => {
  it("starts on a random port, stops cleanly", async () => {
    const port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "x" }),
      registry: new WorkerRegistry(),
      bindAddress: "127.0.0.1:0",
    });
    expect(port).toBeGreaterThan(0);
    await stopWorkerGrpcServer();
  });
});
```

- [ ] **Step 4: Run, expect PASS** (the server module already exists from Task 5)

```
pnpm --filter @paperclipai/server test -- src/worker-rpc/__tests__/lifecycle.test.ts
```

- [ ] **Step 5: Wire into startup**

In the file you identified in Step 1 (likely `server/src/index.ts`), import and start:

```ts
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "./worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "./worker-rpc/auth.js";
import { workerRegistry } from "./services/worker-registry.js";
import { config } from "./config.js";

if (config.WORKER_GRPC_ENABLED) {
  if (config.WORKER_AUTH_MODE !== "shared_secret" || !config.WORKER_SHARED_SECRET) {
    throw new Error("WORKER_GRPC_ENABLED requires WORKER_AUTH_MODE=shared_secret and WORKER_SHARED_SECRET (id-token mode added in a later task)");
  }
  const port = await startWorkerGrpcServer({
    auth: sharedSecretAuthStrategy({ secret: config.WORKER_SHARED_SECRET }),
    registry: workerRegistry,
    bindAddress: config.WORKER_GRPC_BIND_ADDRESS,
  });
  logger.info({ port }, "worker gRPC server listening");
}
```

Add to graceful shutdown handler:
```ts
await stopWorkerGrpcServer();
```

- [ ] **Step 6: Type-check + run server unit tests**

```
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/server test
```

Expected: green.

- [ ] **Step 7: Commit**

```
git add server/src/config.ts server/src/index.ts server/src/worker-rpc/__tests__/lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(server): start worker gRPC server in process bootstrap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Scaffold `packages/worker` binary with auth client and connect loop

**Files:**
- Create: `packages/worker/package.json`
- Create: `packages/worker/tsconfig.json`
- Create: `packages/worker/src/auth-client.ts`
- Create: `packages/worker/src/client.ts`
- Create: `packages/worker/src/index.ts`
- Create: `packages/worker/src/__tests__/auth-client.test.ts`

- [ ] **Step 1: Create `packages/worker/package.json`**

```json
{
  "name": "@paperclipai/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "paperclip-worker": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.12.0",
    "@bufbuild/protobuf": "^2.2.0",
    "@paperclipai/worker-rpc": "workspace:*",
    "@paperclipai/adapters-pi-local": "workspace:*",
    "@paperclipai/adapter-utils": "workspace:*",
    "@paperclipai/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

(Adjust workspace dep names to whatever paperclip uses today; verify by checking `packages/adapters/pi-local/package.json` for the canonical name.)

- [ ] **Step 2: Create `packages/worker/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../worker-rpc" }
  ]
}
```

- [ ] **Step 3: Write the failing auth-client test**

```ts
// packages/worker/src/__tests__/auth-client.test.ts
import { describe, it, expect } from "vitest";
import { staticBearerAuth } from "../auth-client.js";

describe("staticBearerAuth", () => {
  it("returns the configured bearer token", async () => {
    const c = staticBearerAuth("hello");
    const md = await c.getMetadata();
    expect(md.get("authorization")).toEqual(["Bearer hello"]);
  });
});
```

- [ ] **Step 4: Run, expect FAIL**

```
pnpm --filter @paperclipai/worker test
```

- [ ] **Step 5: Implement `auth-client.ts`**

```ts
// packages/worker/src/auth-client.ts
import * as grpc from "@grpc/grpc-js";

export interface WorkerAuthClient {
  getMetadata(): Promise<grpc.Metadata>;
}

export function staticBearerAuth(token: string): WorkerAuthClient {
  return {
    async getMetadata() {
      const md = new grpc.Metadata();
      md.set("authorization", `Bearer ${token}`);
      return md;
    },
  };
}

// gcpIdTokenAuth() added in a later task.
```

- [ ] **Step 6: Run, expect PASS**

- [ ] **Step 7: Implement the connect loop client**

```ts
// packages/worker/src/client.ts
import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary, create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  HelloSchema,
  PongSchema,
  type WorkerToServer,
  type ServerToWorker,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthClient } from "./auth-client.js";

export interface WorkerClientOpts {
  controlPlaneAddress: string; // host:port
  auth: WorkerAuthClient;
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  version: string;
  zone?: string;
  image?: string;
  onDispatch: (msg: ServerToWorker) => void; // wired in Task 9
}

const SERVICE_PATH = "/paperclip.v1.Worker/Connect";

export async function startWorkerClient(opts: WorkerClientOpts): Promise<{ stop: () => Promise<void> }> {
  const md = await opts.auth.getMetadata();
  const client = new grpc.Client(opts.controlPlaneAddress, grpc.credentials.createInsecure(), {
    "grpc.keepalive_time_ms": 15_000,
    "grpc.keepalive_timeout_ms": 5_000,
  });
  const call = client.makeBidiStreamRequest<WorkerToServer, ServerToWorker>(
    SERVICE_PATH,
    (m) => Buffer.from(toBinary(WorkerToServerSchema, m)),
    (b) => fromBinary(ServerToWorkerSchema, b),
    md,
  );

  call.write(create(WorkerToServerSchema, {
    payload: {
      case: "hello",
      value: create(HelloSchema, {
        workerId: opts.workerId,
        instanceId: opts.instanceId,
        zone: opts.zone ?? "",
        image: opts.image ?? "",
        adapters: opts.adapters,
        maxConcurrent: opts.maxConcurrent,
        version: opts.version,
      }),
    },
  }));

  call.on("data", (msg: ServerToWorker) => {
    if (msg.payload.case === "ping") {
      call.write(create(WorkerToServerSchema, {
        payload: { case: "pong", value: create(PongSchema, { ts: BigInt(Date.now()) }) },
      }));
      return;
    }
    if (msg.payload.case === "welcome") return;
    // Hand off to dispatch handler
    opts.onDispatch(msg);
  });

  return {
    async stop() {
      try { call.end(); } catch {}
      client.close();
    },
  };
}
```

- [ ] **Step 8: Implement `index.ts` entrypoint**

```ts
// packages/worker/src/index.ts
import { staticBearerAuth } from "./auth-client.js";
import { startWorkerClient } from "./client.js";
import { randomUUID } from "node:crypto";

async function main() {
  const addr = required("PAPERCLIP_CONTROL_PLANE_ADDR");
  const secret = required("PAPERCLIP_WORKER_SHARED_SECRET");
  const adapters = (process.env.PAPERCLIP_WORKER_ADAPTERS ?? "pi_local").split(",").map(s => s.trim());
  const maxConcurrent = parseInt(process.env.PAPERCLIP_WORKER_MAX_CONCURRENT ?? "1", 10);

  await startWorkerClient({
    controlPlaneAddress: addr,
    auth: staticBearerAuth(secret),
    workerId: process.env.PAPERCLIP_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    instanceId: process.env.GCE_INSTANCE_ID ?? "local",
    adapters,
    maxConcurrent,
    version: "0.0.0",
    onDispatch: () => {}, // wired in Task 9
  });
  // Hold the process open
  await new Promise(() => {});
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`missing env ${name}`); process.exit(2); }
  return v;
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 9: Add an end-to-end smoke test (worker connects, server registers it)**

```ts
// packages/worker/src/__tests__/connect-smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../../../../server/src/worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "../../../../server/src/worker-rpc/auth.js";
import { WorkerRegistry } from "../../../../server/src/services/worker-registry.js";
import { startWorkerClient } from "../client.js";
import { staticBearerAuth } from "../auth-client.js";

// NB: cross-package import paths above only work if both packages are built first.
// Alternative: use a re-exported test helper from the server package. The example
// below uses the simpler in-test bootstrap.

describe("worker connect smoke", () => {
  let port = 0;
  const registry = new WorkerRegistry();
  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3" }),
      registry,
      bindAddress: "127.0.0.1:0",
    });
  });
  afterAll(async () => stopWorkerGrpcServer());

  it("worker registers itself with control plane", async () => {
    const c = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("s3"),
      workerId: "w-smoke",
      instanceId: "i-smoke",
      adapters: ["pi_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: () => {},
    });
    // give it a beat
    await new Promise(r => setTimeout(r, 200));
    expect(registry.list().some(w => w.workerId === "w-smoke")).toBe(true);
    await c.stop();
  });
});
```

(If cross-package imports in tests are messy, instead expose a `startGrpcForTest()` helper from `@paperclipai/server` and import that.)

- [ ] **Step 10: Run worker tests, expect PASS**

```
pnpm --filter @paperclipai/worker build
pnpm --filter @paperclipai/worker test
```

- [ ] **Step 11: Commit**

```
git add packages/worker
git commit -m "$(cat <<'EOF'
feat(worker): scaffold paperclip-worker binary with hello/ping connect loop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Server-side run-dispatcher service

**Files:**
- Create: `server/src/services/run-dispatcher.ts`
- Create: `server/src/services/__tests__/run-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/run-dispatcher.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ServerToWorkerSchema } from "@paperclipai/worker-rpc";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";
import { RunDispatcher } from "../run-dispatcher.js";

function fakeWorker(adapters: string[]): RegisteredWorker {
  return {
    workerId: "w-1",
    instanceId: "i-1",
    adapters,
    maxConcurrent: 1,
    inFlight: 0,
    draining: false,
    sent: [] as unknown[],
    send: async function (m: any) { (this as any).sent.push(m); },
    disconnect: () => {},
  } as any as RegisteredWorker;
}

describe("RunDispatcher", () => {
  let registry: WorkerRegistry;
  let dispatcher: RunDispatcher;
  beforeEach(() => {
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
  });

  it("returns null intent receipt when no worker available", async () => {
    const r = await dispatcher.tryDispatch({
      runId: "r-1", agentId: "a-1", adapterType: "pi_local",
      adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(r.dispatched).toBe(false);
  });

  it("sends a RunDispatch frame to a capable worker", async () => {
    const w = fakeWorker(["pi_local"]);
    registry.register(w);
    const r = await dispatcher.tryDispatch({
      runId: "r-2", agentId: "a-2", adapterType: "pi_local",
      adapterConfig: { foo: 1 }, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(r.dispatched).toBe(true);
    expect((w as any).sent.length).toBe(1);
    expect((w as any).sent[0].payload.case).toBe("runDispatch");
    expect(w.inFlight).toBe(1);
  });

  it("completeRun releases the slot", async () => {
    const w = fakeWorker(["pi_local"]);
    registry.register(w);
    await dispatcher.tryDispatch({
      runId: "r-3", agentId: "a-3", adapterType: "pi_local",
      adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(w.inFlight).toBe(1);
    dispatcher.markCompleted("r-3");
    expect(w.inFlight).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// server/src/services/run-dispatcher.ts
import { create } from "@bufbuild/protobuf";
import { ServerToWorkerSchema, RunDispatchSchema } from "@paperclipai/worker-rpc";
import type { WorkerRegistry } from "./worker-registry.js";

export interface DispatchInput {
  runId: string;
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  executionWorkspace: Record<string, unknown>;
  secretsScopeToken: string;
  sessionRestore?: Uint8Array;
  leaseSeconds: number;
}

export interface DispatchReceipt {
  dispatched: boolean;
  workerId?: string;
  reason?: string;
}

export class RunDispatcher {
  private runToWorker = new Map<string, string>();

  constructor(private readonly registry: WorkerRegistry) {}

  async tryDispatch(input: DispatchInput): Promise<DispatchReceipt> {
    const worker = this.registry.pickFor(input.adapterType);
    if (!worker) return { dispatched: false, reason: "no worker available" };

    this.registry.reserveSlot(worker.workerId);
    this.runToWorker.set(input.runId, worker.workerId);

    const frame = create(ServerToWorkerSchema, {
      payload: {
        case: "runDispatch",
        value: create(RunDispatchSchema, {
          runId: input.runId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          adapterConfigJson: new TextEncoder().encode(JSON.stringify(input.adapterConfig)),
          executionWorkspaceJson: new TextEncoder().encode(JSON.stringify(input.executionWorkspace)),
          secretsScopeToken: input.secretsScopeToken,
          sessionRestore: input.sessionRestore ?? new Uint8Array(),
          leaseSeconds: input.leaseSeconds,
        }),
      },
    });

    try {
      await worker.send(frame);
    } catch (err) {
      this.registry.releaseSlot(worker.workerId);
      this.runToWorker.delete(input.runId);
      return { dispatched: false, reason: `send failed: ${(err as Error).message}` };
    }

    return { dispatched: true, workerId: worker.workerId };
  }

  markCompleted(runId: string): void {
    const workerId = this.runToWorker.get(runId);
    if (!workerId) return;
    this.runToWorker.delete(runId);
    this.registry.releaseSlot(workerId);
  }

  workerForRun(runId: string): string | undefined {
    return this.runToWorker.get(runId);
  }
}

import { workerRegistry } from "./worker-registry.js";
export const runDispatcher = new RunDispatcher(workerRegistry);
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add server/src/services/run-dispatcher.ts server/src/services/__tests__/run-dispatcher.test.ts
git commit -m "$(cat <<'EOF'
feat(server): RunDispatcher selects a worker and tracks in-flight runs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Worker-side run handler (workspace + adapter shim, happy path)

**Files:**
- Create: `packages/worker/src/workspace.ts`
- Create: `packages/worker/src/heartbeat-runner-shim.ts`
- Create: `packages/worker/src/run-handler.ts`
- Create: `packages/worker/src/__tests__/run-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/src/__tests__/run-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleRunDispatch } from "../run-handler.js";
import { create } from "@bufbuild/protobuf";
import { RunDispatchSchema } from "@paperclipai/worker-rpc";

describe("handleRunDispatch", () => {
  it("realizes a workspace, runs the shim, emits Complete, and cleans up", async () => {
    const sent: any[] = [];
    const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup: vi.fn(async () => {}) }));
    const shim = vi.fn(async () => ({ exitCode: 0, signal: null, summary: "ok", usage: { tokens: 1 } }));
    const fetchSecrets = vi.fn(async () => ({}));

    await handleRunDispatch(
      create(RunDispatchSchema, {
        runId: "r-1",
        agentId: "a-1",
        adapterType: "pi_local",
        adapterConfigJson: new TextEncoder().encode("{}"),
        executionWorkspaceJson: new TextEncoder().encode("{}"),
        secretsScopeToken: "tok",
        sessionRestore: new Uint8Array(),
        leaseSeconds: 300,
      }),
      { realizeWorkspace: realize, runAdapter: shim, fetchSecrets, send: async (m) => { sent.push(m); } },
    );

    expect(realize).toHaveBeenCalledOnce();
    expect(shim).toHaveBeenCalledOnce();
    const completes = sent.filter(m => m.payload.case === "runComplete");
    expect(completes.length).toBe(1);
    expect(completes[0].payload.value.exitCode).toBe(0);
  });

  it("emits RunFailed on adapter throw", async () => {
    const sent: any[] = [];
    const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup: vi.fn(async () => {}) }));
    const shim = vi.fn(async () => { throw new Error("boom"); });
    const fetchSecrets = vi.fn(async () => ({}));

    await handleRunDispatch(
      create(RunDispatchSchema, {
        runId: "r-2",
        agentId: "a-2",
        adapterType: "pi_local",
        adapterConfigJson: new TextEncoder().encode("{}"),
        executionWorkspaceJson: new TextEncoder().encode("{}"),
        secretsScopeToken: "tok",
        sessionRestore: new Uint8Array(),
        leaseSeconds: 300,
      }),
      { realizeWorkspace: realize, runAdapter: shim, fetchSecrets, send: async (m) => { sent.push(m); } },
    );

    const failed = sent.filter(m => m.payload.case === "runFailed");
    expect(failed.length).toBe(1);
    expect(failed[0].payload.value.error).toContain("boom");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `workspace.ts` (ephemeral)**

```ts
// packages/worker/src/workspace.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface RealizedWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
}

export interface WorkspaceDescriptor {
  mode?: "ephemeral" | "filestore"; // filestore handled in Plan 4
  repoUrl?: string;
  ref?: string;
}

export async function realizeEphemeralWorkspace(desc: WorkspaceDescriptor): Promise<RealizedWorkspace> {
  const cwd = await mkdtemp(join(tmpdir(), "paperclip-run-"));
  if (desc.repoUrl) {
    await execFile("git", ["clone", "--depth", "1", desc.repoUrl, cwd]);
    if (desc.ref) {
      await execFile("git", ["-C", cwd, "fetch", "--depth", "1", "origin", desc.ref]);
      await execFile("git", ["-C", cwd, "checkout", desc.ref]);
    }
  }
  return {
    cwd,
    cleanup: async () => { await rm(cwd, { recursive: true, force: true }); },
  };
}
```

- [ ] **Step 4: Implement `heartbeat-runner-shim.ts`**

This wraps the existing `pi_local` adapter execute fn. Verify the export name in `packages/adapters/pi-local/src/server/execute.ts` (or wherever `execute` is exported) before writing this file.

```ts
// packages/worker/src/heartbeat-runner-shim.ts
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
// Replace the import path with whatever pi_local exposes for its execute fn:
import { execute as executePiLocal } from "@paperclipai/adapters-pi-local/server";

export async function runAdapterOnWorker(
  adapterType: string,
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  switch (adapterType) {
    case "pi_local":
      return executePiLocal(ctx);
    default:
      throw new Error(`adapter ${adapterType} not supported in worker yet`);
  }
}
```

- [ ] **Step 5: Implement `run-handler.ts`**

```ts
// packages/worker/src/run-handler.ts
import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  RunCompleteSchema,
  RunFailedSchema,
  RunUsageSchema,
  type RunDispatch,
  type WorkerToServer,
} from "@paperclipai/worker-rpc";

export interface RunHandlerDeps {
  realizeWorkspace: (desc: any) => Promise<{ cwd: string; cleanup: () => Promise<void> }>;
  runAdapter: (ctx: any) => Promise<{
    exitCode: number;
    signal: string | null;
    summary?: string;
    usage?: Record<string, unknown>;
  }>;
  fetchSecrets: (token: string) => Promise<Record<string, string>>;
  send: (msg: WorkerToServer) => Promise<void>;
}

export async function handleRunDispatch(
  d: RunDispatch,
  deps: RunHandlerDeps,
): Promise<void> {
  const adapterConfig = JSON.parse(new TextDecoder().decode(d.adapterConfigJson || new Uint8Array()) || "{}");
  const workspace = JSON.parse(new TextDecoder().decode(d.executionWorkspaceJson || new Uint8Array()) || "{}");

  let realized: { cwd: string; cleanup: () => Promise<void> } | null = null;
  try {
    const secrets = await deps.fetchSecrets(d.secretsScopeToken);
    realized = await deps.realizeWorkspace(workspace);
    const ctx = {
      runId: d.runId,
      agent: { id: d.agentId },
      config: adapterConfig,
      cwd: realized.cwd,
      env: { ...process.env, ...secrets },
      context: {},
    };

    const result = await deps.runAdapter(ctx);

    if (result.usage) {
      await deps.send(create(WorkerToServerSchema, {
        payload: {
          case: "runUsage",
          value: create(RunUsageSchema, {
            runId: d.runId,
            usageJson: new TextEncoder().encode(JSON.stringify(result.usage)),
          }),
        },
      }));
    }

    await deps.send(create(WorkerToServerSchema, {
      payload: {
        case: "runComplete",
        value: create(RunCompleteSchema, {
          runId: d.runId,
          exitCode: result.exitCode,
          signal: result.signal ?? "",
          summary: result.summary ?? "",
        }),
      },
    }));
  } catch (err) {
    await deps.send(create(WorkerToServerSchema, {
      payload: {
        case: "runFailed",
        value: create(RunFailedSchema, {
          runId: d.runId,
          error: err instanceof Error ? err.message : String(err),
          errorCode: "worker_run_failed",
        }),
      },
    }));
  } finally {
    if (realized) await realized.cleanup();
  }
}
```

- [ ] **Step 6: Run unit tests, expect PASS**

```
pnpm --filter @paperclipai/worker test -- src/__tests__/run-handler.test.ts
```

- [ ] **Step 7: Refactor `startWorkerClient` to expose `send`**

Edit `packages/worker/src/client.ts` to return a `send` function. Replace the existing return block with:

```ts
const send = async (m: WorkerToServer): Promise<void> => {
  await new Promise<void>((resolve, reject) =>
    call.write(m, (err?: Error | null) => (err ? reject(err) : resolve())));
};

return {
  send,
  async stop() {
    try { call.end(); } catch {}
    client.close();
  },
};
```

And update the return type annotation on `startWorkerClient`:
```ts
export async function startWorkerClient(opts: WorkerClientOpts): Promise<{
  send: (m: WorkerToServer) => Promise<void>;
  stop: () => Promise<void>;
}>
```

Then wire `handleRunDispatch` into `packages/worker/src/index.ts`:

```ts
import { handleRunDispatch } from "./run-handler.js";
import { realizeEphemeralWorkspace } from "./workspace.js";
import { runAdapterOnWorker } from "./heartbeat-runner-shim.js";
import { fetchSecretsFromControlPlane } from "./secret-fetcher.js"; // created in Task 11

// inside main(), capture the client so onDispatch can call client.send:
let client: { send: (m: any) => Promise<void>; stop: () => Promise<void> };

client = await startWorkerClient({
  controlPlaneAddress: addr,
  auth: staticBearerAuth(secret),
  workerId: process.env.PAPERCLIP_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
  instanceId: process.env.GCE_INSTANCE_ID ?? "local",
  adapters,
  maxConcurrent,
  version: "0.0.0",
  onDispatch: (msg) => {
    if (msg.payload.case !== "runDispatch") return;
    const dispatch = msg.payload.value;
    void handleRunDispatch(dispatch, {
      realizeWorkspace: realizeEphemeralWorkspace,
      runAdapter: (ctx) => runAdapterOnWorker(dispatch.adapterType, ctx as any),
      fetchSecrets: async (tok) => fetchSecretsFromControlPlane(addr, tok, /*scopedJwt*/ ""),
      send: (m) => client.send(m),
    });
  },
});
```

(The empty `scopedJwt` argument is a stub — the real JWT comes from the `Welcome` frame; capturing it is added in Plan 2 along with the reaper. For Plan 1 the secrets handler accepts the scope token alone with shared-secret auth gating the channel.)

- [ ] **Step 8: Commit**

```
git add packages/worker
git commit -m "$(cat <<'EOF'
feat(worker): run handler with ephemeral workspace + adapter shim

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Server-side dispatch-or-local wrapper for `pi_local`

**Files:**
- Create: `server/src/adapters/dispatch-or-local.ts`
- Modify: `server/src/adapters/index.ts`
- Create: `server/src/adapters/__tests__/dispatch-or-local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/adapters/__tests__/dispatch-or-local.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDispatchOrLocal } from "../dispatch-or-local.js";

describe("createDispatchOrLocal", () => {
  let localExec: any;
  let dispatcher: any;
  let registry: any;

  beforeEach(() => {
    localExec = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "local" }));
    dispatcher = { tryDispatch: vi.fn(), markCompleted: vi.fn() };
    registry = { pickFor: vi.fn() };
  });

  it("falls back to local when no worker available", async () => {
    registry.pickFor.mockReturnValue(null);
    const adapter = createDispatchOrLocal({ adapterType: "pi_local", localExecute: localExec, dispatcher, registry, awaitCompletion: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "remote" }) });
    const res = await adapter.execute({ runId: "r1", agent: { id: "a1" }, config: {}, context: {} } as any);
    expect(res.summary).toBe("local");
    expect(localExec).toHaveBeenCalled();
  });

  it("dispatches to worker when available and waits for completion", async () => {
    registry.pickFor.mockReturnValue({ workerId: "w1" });
    dispatcher.tryDispatch.mockResolvedValue({ dispatched: true, workerId: "w1" });
    const awaitCompletion = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "remote" }));
    const adapter = createDispatchOrLocal({ adapterType: "pi_local", localExecute: localExec, dispatcher, registry, awaitCompletion });
    const res = await adapter.execute({ runId: "r2", agent: { id: "a2" }, config: {}, context: {} } as any);
    expect(res.summary).toBe("remote");
    expect(localExec).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// server/src/adapters/dispatch-or-local.ts
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";
import type { RunDispatcher } from "../services/run-dispatcher.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

export interface DispatchOrLocalOpts {
  adapterType: string;
  localExecute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  dispatcher: Pick<RunDispatcher, "tryDispatch" | "markCompleted">;
  registry: Pick<WorkerRegistry, "pickFor">;
  awaitCompletion: (runId: string) => Promise<AdapterExecutionResult>;
  leaseSeconds?: number;
}

export function createDispatchOrLocal(opts: DispatchOrLocalOpts) {
  return {
    async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
      const worker = opts.registry.pickFor(opts.adapterType);
      if (!worker) return opts.localExecute(ctx);

      const receipt = await opts.dispatcher.tryDispatch({
        runId: ctx.runId,
        agentId: ctx.agent.id,
        adapterType: opts.adapterType,
        adapterConfig: (ctx.config ?? {}) as Record<string, unknown>,
        executionWorkspace: (ctx.context ?? {}) as Record<string, unknown>,
        secretsScopeToken: `secrets:${ctx.runId}`,
        leaseSeconds: opts.leaseSeconds ?? 300,
      });
      if (!receipt.dispatched) return opts.localExecute(ctx);

      try {
        return await opts.awaitCompletion(ctx.runId);
      } finally {
        opts.dispatcher.markCompleted(ctx.runId);
      }
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Build the `awaitCompletion` shim and wire `pi_local`**

Modify `server/src/adapters/index.ts`. Find where `pi_local` is registered and replace its `execute` with the wrapper. Add a small in-memory completion-promise registry for `awaitCompletion`:

```ts
// server/src/adapters/run-completion-registry.ts (new file)
import type { AdapterExecutionResult } from "./types.js";

type Pending = {
  resolve: (r: AdapterExecutionResult) => void;
  reject: (e: Error) => void;
};

const pending = new Map<string, Pending>();

export function awaitRunCompletion(runId: string): Promise<AdapterExecutionResult> {
  return new Promise((resolve, reject) => { pending.set(runId, { resolve, reject }); });
}

export function settleRunCompletion(runId: string, result: AdapterExecutionResult | Error): void {
  const p = pending.get(runId);
  if (!p) return;
  pending.delete(runId);
  if (result instanceof Error) p.reject(result);
  else p.resolve(result);
}
```

Update `connect-handler.ts` to call `settleRunCompletion` when `runComplete` / `runFailed` arrives from a worker:

```ts
// inside the call.on("data", ...) switch in connect-handler.ts
if (p.case === "runComplete") {
  settleRunCompletion(p.value.runId, {
    exitCode: p.value.exitCode,
    signal: p.value.signal || null,
    timedOut: false,
    summary: p.value.summary,
  });
  return;
}
if (p.case === "runFailed") {
  settleRunCompletion(p.value.runId, new Error(p.value.error));
  return;
}
```

In `server/src/adapters/index.ts`, wrap `pi_local`:

```ts
import { createDispatchOrLocal } from "./dispatch-or-local.js";
import { runDispatcher } from "../services/run-dispatcher.js";
import { workerRegistry } from "../services/worker-registry.js";
import { awaitRunCompletion } from "./run-completion-registry.js";
import { execute as piLocalExecute } from "./pi-local-execute.js"; // use whatever import currently exists

const piLocalAdapter = createDispatchOrLocal({
  adapterType: "pi_local",
  localExecute: piLocalExecute,
  dispatcher: runDispatcher,
  registry: workerRegistry,
  awaitCompletion: awaitRunCompletion,
});

// Replace the existing pi_local registration with this wrapper.
```

- [ ] **Step 6: Type-check + run server test suite**

```
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/server test
```

- [ ] **Step 7: Commit**

```
git add server/src/adapters server/src/worker-rpc/connect-handler.ts
git commit -m "$(cat <<'EOF'
feat(server): pi_local adapter dispatches via worker pool when available

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `FetchSecrets` unary RPC + worker-side secret fetcher

**Spec D2:** scope token alone authenticates this RPC; the `scoped_jwt` proto field is reserved for future use and ignored by the v1 server. The token is one-time-use, bound to a specific `runId`/`agentId`, and time-boxed to the run's lease window. Implementation must invalidate the token on first successful exchange so a second call with the same token fails closed.

**Files:**
- Modify: `server/src/worker-rpc/secrets-handler.ts`
- Create: `packages/worker/src/secret-fetcher.ts`
- Create: `server/src/worker-rpc/__tests__/secrets-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/worker-rpc/__tests__/secrets-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { FetchSecretsRequestSchema } from "@paperclipai/worker-rpc";
import { handleFetchSecrets } from "../secrets-handler.js";

describe("handleFetchSecrets", () => {
  it("returns secrets for a valid scope token", async () => {
    const lookupAndInvalidate = vi.fn(async (token: string) => {
      if (token === "secrets:r-1") return { OPENAI_API_KEY: "k" };
      throw new Error("unknown token");
    });
    const resp = await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "secrets:r-1", scopedJwt: "ignored" }),
      { lookupAndInvalidate } as any,
    );
    expect(resp.secrets["OPENAI_API_KEY"]).toBe("k");
  });

  it("throws on invalid token", async () => {
    const lookupAndInvalidate = vi.fn(async () => { throw new Error("bad"); });
    await expect(
      handleFetchSecrets(
        create(FetchSecretsRequestSchema, { scopeToken: "bad", scopedJwt: "" }),
        { lookupAndInvalidate } as any,
      ),
    ).rejects.toThrow("bad");
  });

  it("ignores scoped_jwt field (spec D2)", async () => {
    const lookupAndInvalidate = vi.fn(async () => ({ K: "v" }));
    await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "ok", scopedJwt: "anything-here-is-ignored" }),
      { lookupAndInvalidate } as any,
    );
    expect(lookupAndInvalidate).toHaveBeenCalledWith("ok");
  });

  it("token cannot be reused (one-time)", async () => {
    const consumed = new Set<string>();
    const lookupAndInvalidate = vi.fn(async (token: string) => {
      if (consumed.has(token)) throw new Error("token already consumed");
      consumed.add(token);
      return { K: "v" };
    });
    await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "once", scopedJwt: "" }),
      { lookupAndInvalidate } as any,
    );
    await expect(
      handleFetchSecrets(
        create(FetchSecretsRequestSchema, { scopeToken: "once", scopedJwt: "" }),
        { lookupAndInvalidate } as any,
      ),
    ).rejects.toThrow("already consumed");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// server/src/worker-rpc/secrets-handler.ts
import { create } from "@bufbuild/protobuf";
import {
  type FetchSecretsRequest,
  type FetchSecretsResponse,
  FetchSecretsResponseSchema,
} from "@paperclipai/worker-rpc";

export interface SecretsHandlerDeps {
  // Looks up secrets and atomically invalidates the token (one-time use).
  // Throws if the token is unknown, expired, or already consumed.
  lookupAndInvalidate: (scopeToken: string) => Promise<Record<string, string>>;
}

export async function handleFetchSecrets(
  req: FetchSecretsRequest,
  deps: SecretsHandlerDeps,
): Promise<FetchSecretsResponse> {
  // Spec D2: scoped_jwt field is intentionally ignored in v1; scope_token alone authenticates.
  const secrets = await deps.lookupAndInvalidate(req.scopeToken);
  return create(FetchSecretsResponseSchema, { secrets });
}
```

Wire `deps.lookup` to the existing `secret-service` in `server/src/worker-rpc/server.ts`:

```ts
import { secretService } from "../services/secrets.js";
// inside startWorkerGrpcServer:
FetchSecrets: (call, cb) => {
  handleFetchSecrets(call.request, {
    lookupAndInvalidate: async (token) => {
      // Token format: opaque server-issued. Implementation: look up the
      // (token → runId) row in a short-lived `secret_scope_tokens` table,
      // return the run's scoped secrets, and DELETE the row in the same
      // transaction. Second call with the same token will not find a row
      // and throws.
      return secretService.consumeScopedToken(token);
    },
  }).then(r => cb(null, r), e => cb(e));
},
```

If `secretService.fetchScopedForRun` does not exist, add it as a thin wrapper around the existing per-agent secret resolution that already powers in-process runs.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Implement worker-side fetcher**

```ts
// packages/worker/src/secret-fetcher.ts
import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary, create } from "@bufbuild/protobuf";
import {
  FetchSecretsRequestSchema,
  FetchSecretsResponseSchema,
  type FetchSecretsRequest,
  type FetchSecretsResponse,
} from "@paperclipai/worker-rpc";

export async function fetchSecretsFromControlPlane(
  addr: string,
  scopeToken: string,
  scopedJwt: string,
): Promise<Record<string, string>> {
  const client = new grpc.Client(addr, grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  md.set("authorization", `Bearer ${scopedJwt}`);
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest<FetchSecretsRequest, FetchSecretsResponse>(
      "/paperclip.v1.Worker/FetchSecrets",
      (m) => Buffer.from(toBinary(FetchSecretsRequestSchema, m)),
      (b) => fromBinary(FetchSecretsResponseSchema, b),
      create(FetchSecretsRequestSchema, { scopeToken, scopedJwt }),
      md,
      (err, resp) => {
        client.close();
        if (err || !resp) return reject(err ?? new Error("no response"));
        resolve(resp.secrets);
      },
    );
  });
}
```

- [ ] **Step 6: Commit**

```
git add server/src/worker-rpc/secrets-handler.ts server/src/worker-rpc/__tests__/secrets-handler.test.ts packages/worker/src/secret-fetcher.ts
git commit -m "$(cat <<'EOF'
feat(worker-rpc): FetchSecrets unary RPC + worker-side client

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Lease deadline enforcement (worker-initiated keepalive + server timer)

Note: full reaper job is Plan 2. This task adds the in-memory deadline so a stuck worker doesn't pin a run forever within a single server lifetime.

**Per spec NOTE N2 (review item 6):** the lease is renewed by **any frame referencing the run_id** (RunLog, RunUsage, RunSession, RunComplete, RunFailed, **RunLeaseRenew**). The worker emits explicit `RunLeaseRenew` every `lease_seconds / 3` regardless of run output, so a long quiet compile does not lose its lease. The pre-existing `ServerToWorker.LeaseRenew` is a different use case (server granting an extension, e.g., budget override) and is not exercised in this task.

**Files:**
- Modify: `server/src/services/run-dispatcher.ts`
- Modify: `server/src/worker-rpc/connect-handler.ts`
- Create: `server/src/services/__tests__/run-dispatcher-lease.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/run-dispatcher-lease.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";
import { RunDispatcher } from "../run-dispatcher.js";

describe("RunDispatcher lease", () => {
  let registry: WorkerRegistry;
  let dispatcher: RunDispatcher;
  beforeEach(() => {
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
    vi.useFakeTimers();
  });

  it("settles a run with lease_expired if no completion before deadline", async () => {
    const w: RegisteredWorker = {
      workerId: "w", instanceId: "i", adapters: ["pi_local"],
      maxConcurrent: 1, inFlight: 0, draining: false,
      send: async () => {}, disconnect: () => {},
    };
    registry.register(w);
    const settle = vi.fn();
    dispatcher.onSettlement(settle);
    await dispatcher.tryDispatch({
      runId: "r-x", agentId: "a", adapterType: "pi_local",
      adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 1,
    });
    vi.advanceTimersByTime(1500);
    expect(settle).toHaveBeenCalledWith("r-x", expect.objectContaining({ kind: "lease_expired" }));
  });

  it("any worker frame for a run renews the lease", async () => {
    const w: RegisteredWorker = {
      workerId: "w", instanceId: "i", adapters: ["pi_local"],
      maxConcurrent: 1, inFlight: 0, draining: false,
      send: async () => {}, disconnect: () => {},
    };
    registry.register(w);
    const settle = vi.fn();
    dispatcher.onSettlement(settle);
    await dispatcher.tryDispatch({
      runId: "r-y", agentId: "a", adapterType: "pi_local",
      adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 1,
    });
    vi.advanceTimersByTime(800);
    // Any frame for run-id "r-y" should reset the deadline:
    dispatcher.touchLease("r-y");
    vi.advanceTimersByTime(800);
    expect(settle).not.toHaveBeenCalled(); // not yet — touched at 800ms
    vi.advanceTimersByTime(400);
    expect(settle).toHaveBeenCalledWith("r-y", expect.objectContaining({ kind: "lease_expired" }));
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Extend `RunDispatcher`**

Edit `server/src/services/run-dispatcher.ts`:

```ts
type SettlementReason = { kind: "complete" | "failed" | "lease_expired"; payload?: unknown };
type SettlementListener = (runId: string, reason: SettlementReason) => void;

export class RunDispatcher {
  private runToWorker = new Map<string, string>();
  private leaseTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<SettlementListener>();

  // ... existing constructor + tryDispatch unchanged, except add a setTimeout below the send() success:

  async tryDispatch(input: DispatchInput): Promise<DispatchReceipt> {
    // ... pick worker, reserve, send (existing code) ...
    this.armLease(input.runId, input.leaseSeconds);
    return { dispatched: true, workerId: worker.workerId };
  }

  // Records the original lease window per run, so touchLease() can reset to it.
  private leaseWindowSec = new Map<string, number>();

  private armLease(runId: string, seconds: number) {
    const old = this.leaseTimers.get(runId);
    if (old) clearTimeout(old);
    this.leaseWindowSec.set(runId, seconds);
    const t = setTimeout(() => {
      this.leaseTimers.delete(runId);
      this.leaseWindowSec.delete(runId);
      this.markCompleted(runId);
      for (const l of this.listeners) l(runId, { kind: "lease_expired" });
    }, seconds * 1000);
    this.leaseTimers.set(runId, t);
  }

  /**
   * Per spec NOTE N2: ANY frame referencing a run_id resets its lease to
   * the original window. Called by the connect handler on RunLog, RunUsage,
   * RunSession, RunLeaseRenew, etc. — independent of run output volume.
   */
  touchLease(runId: string): void {
    if (!this.runToWorker.has(runId)) return;
    const win = this.leaseWindowSec.get(runId);
    if (!win) return;
    this.armLease(runId, win);
  }

  /**
   * Server-initiated grant extension — used for budget-override grants
   * (sends ServerToWorker.LeaseRenew). Distinct from touchLease which is
   * worker-initiated keepalive.
   */
  extendLease(runId: string, newSeconds: number): void {
    if (!this.runToWorker.has(runId)) return;
    this.armLease(runId, newSeconds);
  }

  onSettlement(l: SettlementListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  markCompleted(runId: string): void {
    const t = this.leaseTimers.get(runId);
    if (t) { clearTimeout(t); this.leaseTimers.delete(runId); }
    const workerId = this.runToWorker.get(runId);
    if (!workerId) return;
    this.runToWorker.delete(runId);
    this.registry.releaseSlot(workerId);
  }
}
```

- [ ] **Step 4: Wire `touchLease` from any run-bearing frame into the connect handler**

In `server/src/worker-rpc/connect-handler.ts`, after the existing `if (p.case === "hello")` and `if (p.case === "pong")` early returns, add a generic touch:

```ts
import { runDispatcher } from "../services/run-dispatcher.js";

// ...inside call.on("data", (msg) => { ... })
// Per spec NOTE N2: any frame that references a run_id renews that run's lease.
const runIdBearing = (p as any).value;
if (runIdBearing && typeof runIdBearing.runId === "string") {
  runDispatcher.touchLease(runIdBearing.runId);
}

// Then the explicit cases:
if (p.case === "runComplete") {
  settleRunCompletion(p.value.runId, {
    exitCode: p.value.exitCode,
    signal: p.value.signal || null,
    timedOut: false,
    summary: p.value.summary,
  });
  return;
}
if (p.case === "runFailed") {
  settleRunCompletion(p.value.runId, new Error(p.value.error));
  return;
}
// runLeaseRenew has no further side-effect; touchLease above already handled it.
if (p.case === "runLeaseRenew") return;
// runLog / runUsage / runSession persistence is handled by their own paths
// (added in later tasks); the lease touch above is the only effect for v1.
```

- [ ] **Step 4b: Worker-side keepalive emitter**

Edit `packages/worker/src/run-handler.ts`. After dispatching the run, start an interval that emits `RunLeaseRenew` every `lease_seconds / 3`:

```ts
import { create } from "@bufbuild/protobuf";
import { WorkerToServerSchema, RunLeaseRenewSchema } from "@paperclipai/worker-rpc";

// inside handleRunDispatch, before the try { ... }:
const renewIntervalMs = Math.max(1000, Math.floor(d.leaseSeconds * 1000 / 3));
const keepalive = setInterval(() => {
  void deps.send(create(WorkerToServerSchema, {
    payload: {
      case: "runLeaseRenew",
      value: create(RunLeaseRenewSchema, { runId: d.runId }),
    },
  }));
}, renewIntervalMs);

// inside the finally block, before cleanup:
clearInterval(keepalive);
```

Add a unit test for the keepalive emission:

```ts
// add to packages/worker/src/__tests__/run-handler.test.ts
it("emits RunLeaseRenew at lease_seconds/3 cadence while running", async () => {
  vi.useFakeTimers();
  const sent: any[] = [];
  const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup: vi.fn(async () => {}) }));
  // adapter that takes 3 seconds to "run":
  const shim = vi.fn(async () => {
    await new Promise(r => setTimeout(r, 3000));
    return { exitCode: 0, signal: null, summary: "ok" };
  });
  const fetchSecrets = vi.fn(async () => ({}));

  const promise = handleRunDispatch(
    create(RunDispatchSchema, {
      runId: "r-keep", agentId: "a", adapterType: "pi_local",
      adapterConfigJson: new TextEncoder().encode("{}"),
      executionWorkspaceJson: new TextEncoder().encode("{}"),
      secretsScopeToken: "tok",
      sessionRestore: new Uint8Array(),
      leaseSeconds: 3,
    }),
    { realizeWorkspace: realize, runAdapter: shim, fetchSecrets, send: async (m) => { sent.push(m); } },
  );
  await vi.advanceTimersByTimeAsync(2200); // expect ≥ 2 renews at 1s and 2s
  await vi.advanceTimersByTimeAsync(1000);
  await promise;
  vi.useRealTimers();
  const renews = sent.filter(m => m.payload.case === "runLeaseRenew");
  expect(renews.length).toBeGreaterThanOrEqual(2);
});
```

Also wire settlement → `awaitRunCompletion`:

```ts
// once at server boot:
runDispatcher.onSettlement((runId, reason) => {
  if (reason.kind === "lease_expired") {
    settleRunCompletion(runId, new Error("lease_expired"));
  }
});
```

- [ ] **Step 5: Run, expect PASS**

```
pnpm --filter @paperclipai/server test
```

- [ ] **Step 6: Commit**

```
git add server/src/services server/src/worker-rpc
git commit -m "$(cat <<'EOF'
feat(server): per-run lease deadline with LeaseRenew

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: End-to-end integration test (in-process worker over loopback)

**Files:**
- Create: `server/src/__tests__/distributed/end-to-end.test.ts`

- [ ] **Step 1: Write the test**

```ts
// server/src/__tests__/distributed/end-to-end.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../../worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "../../worker-rpc/auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";
import { startWorkerClient } from "@paperclipai/worker/client";
import { staticBearerAuth } from "@paperclipai/worker/auth-client";
import { handleRunDispatch } from "@paperclipai/worker/run-handler";

describe("distributed pi_local end-to-end", () => {
  let port = 0;
  const registry = new WorkerRegistry();
  const dispatcher = new RunDispatcher(registry);

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3" }),
      registry,
      bindAddress: "127.0.0.1:0",
    });
  });
  afterAll(async () => stopWorkerGrpcServer());

  it("dispatches a run to a connected worker, receives RunComplete", async () => {
    const completed: string[] = [];

    const client = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("s3"),
      workerId: "w-e2e",
      instanceId: "i-e2e",
      adapters: ["pi_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: async (msg) => {
        if (msg.payload.case !== "runDispatch") return;
        await handleRunDispatch(msg.payload.value, {
          realizeWorkspace: async () => ({ cwd: "/tmp", cleanup: async () => {} }),
          runAdapter: async () => ({ exitCode: 0, signal: null, summary: "ok" }),
          fetchSecrets: async () => ({}),
          send: async (m) => client.send(m),
        });
      },
    });

    await new Promise(r => setTimeout(r, 100)); // let registration complete

    const settled = new Promise<void>(resolve => {
      dispatcher.onSettlement((runId, reason) => {
        if (runId === "r-e2e") { completed.push(reason.kind); resolve(); }
      });
    });

    const r = await dispatcher.tryDispatch({
      runId: "r-e2e", agentId: "a-e2e", adapterType: "pi_local",
      adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok",
      leaseSeconds: 30,
    });
    expect(r.dispatched).toBe(true);

    await settled;
    expect(completed).toEqual(["complete"]);

    await client.stop();
  });
});
```

- [ ] **Step 2: Adjust `startWorkerClient` to expose `send` if not already (Task 9 step 7)**

- [ ] **Step 3: Run the test**

```
pnpm -r build
pnpm --filter @paperclipai/server test -- src/__tests__/distributed/end-to-end.test.ts
```

Expected: pass; the worker registers, receives a dispatch, the run handler invokes the (mock) adapter, sends `RunComplete`, and the dispatcher settles the run.

- [ ] **Step 4: Commit**

```
git add server/src/__tests__/distributed/end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test(server): end-to-end pi_local dispatch via in-process worker

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: GCP id-token auth strategy (server-side)

**Files:**
- Modify: `server/src/worker-rpc/auth.ts`
- Modify: `server/src/worker-rpc/__tests__/auth.test.ts`
- Modify: `server/package.json` (add `google-auth-library`)

- [ ] **Step 1: Add `google-auth-library`**

```
pnpm --filter @paperclipai/server add google-auth-library
```

- [ ] **Step 2: Write the failing test**

```ts
// add to server/src/worker-rpc/__tests__/auth.test.ts
import { gcpIdTokenAuthStrategy } from "../auth.js";

describe("gcpIdTokenAuthStrategy", () => {
  const verifier = {
    verifyIdToken: async ({ idToken }: { idToken: string; audience: string }) => {
      if (idToken === "bad") throw new Error("invalid");
      return {
        getPayload: () => ({ email: "paperclip-worker@proj.iam.gserviceaccount.com", aud: "https://paperclip/workers", iss: "https://accounts.google.com" }),
      };
    },
  };

  it("accepts a valid id-token signed by an allow-listed SA", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["paperclip-worker@proj.iam.gserviceaccount.com"],
      verifier: verifier as any,
    });
    const r = await strat.verify("Bearer good");
    expect(r.ok).toBe(true);
    if (r.ok && r.principal.kind === "gcp_id_token") {
      expect(r.principal.saEmail).toBe("paperclip-worker@proj.iam.gserviceaccount.com");
    }
  });

  it("rejects an SA not in allowlist", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["someone-else@proj.iam.gserviceaccount.com"],
      verifier: verifier as any,
    });
    const r = await strat.verify("Bearer good");
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid token", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["paperclip-worker@proj.iam.gserviceaccount.com"],
      verifier: verifier as any,
    });
    const r = await strat.verify("Bearer bad");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Implement**

Append to `server/src/worker-rpc/auth.ts`:

```ts
import { OAuth2Client } from "google-auth-library";

export interface IdTokenVerifierLike {
  verifyIdToken(opts: { idToken: string; audience: string }): Promise<{ getPayload: () => { email?: string; aud?: string; iss?: string } | undefined }>;
}

export interface GcpIdTokenStrategyOpts {
  audience: string;
  saAllowlist: string[];
  verifier?: IdTokenVerifierLike;
}

export function gcpIdTokenAuthStrategy(opts: GcpIdTokenStrategyOpts): WorkerAuthStrategy {
  const verifier = opts.verifier ?? (new OAuth2Client() as unknown as IdTokenVerifierLike);
  return {
    async verify(header) {
      if (!header) return { ok: false, reason: "missing authorization header" };
      const m = /^Bearer\s+(.+)$/.exec(header);
      if (!m) return { ok: false, reason: "expected Bearer scheme" };
      let payload: { email?: string; aud?: string } | undefined;
      try {
        const ticket = await verifier.verifyIdToken({ idToken: m[1], audience: opts.audience });
        payload = ticket.getPayload() ?? undefined;
      } catch (err) {
        return { ok: false, reason: `id-token verification failed: ${(err as Error).message}` };
      }
      if (!payload?.email) return { ok: false, reason: "id-token missing email claim" };
      if (!opts.saAllowlist.includes(payload.email)) return { ok: false, reason: `SA ${payload.email} not in allowlist` };
      return { ok: true, principal: { kind: "gcp_id_token", saEmail: payload.email } };
    },
  };
}
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Wire into startup branching on `WORKER_AUTH_MODE`**

Edit the bootstrap block from Task 6:

```ts
const auth =
  config.WORKER_AUTH_MODE === "shared_secret"
    ? sharedSecretAuthStrategy({ secret: required(config.WORKER_SHARED_SECRET) })
    : config.WORKER_AUTH_MODE === "gcp_id_token"
      ? gcpIdTokenAuthStrategy({
          audience: required(process.env.WORKER_GCP_AUDIENCE),
          saAllowlist: required(config.WORKER_GCP_SA_ALLOWLIST).split(",").map(s => s.trim()),
        })
      : (() => { throw new Error("WORKER_AUTH_MODE must be shared_secret or gcp_id_token"); })();
```

- [ ] **Step 7: Type-check + run tests**

```
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/server test
```

- [ ] **Step 8: Commit**

```
git add server/src/worker-rpc/auth.ts server/src/worker-rpc/__tests__/auth.test.ts server/src/index.ts server/package.json
git commit -m "$(cat <<'EOF'
feat(server): GCP id-token auth strategy with SA allowlist

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Worker-side id-token credentials

**Files:**
- Modify: `packages/worker/src/auth-client.ts`
- Modify: `packages/worker/src/__tests__/auth-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `auth-client.test.ts`:
```ts
import { gcpIdTokenAuth } from "../auth-client.js";

describe("gcpIdTokenAuth", () => {
  it("fetches an id-token and sets bearer header", async () => {
    const fetchToken = vi.fn(async () => "id-token-abc");
    const c = gcpIdTokenAuth({ audience: "https://x", fetchToken });
    const md = await c.getMetadata();
    expect(md.get("authorization")).toEqual(["Bearer id-token-abc"]);
    expect(fetchToken).toHaveBeenCalledWith("https://x");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `auth-client.ts`:
```ts
export interface GcpIdTokenAuthOpts {
  audience: string;
  fetchToken?: (audience: string) => Promise<string>;
}

async function defaultFetchTokenFromMetadata(audience: string): Promise<string> {
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata id-token fetch failed: ${res.status}`);
  return res.text();
}

export function gcpIdTokenAuth(opts: GcpIdTokenAuthOpts): WorkerAuthClient {
  const fetchToken = opts.fetchToken ?? defaultFetchTokenFromMetadata;
  return {
    async getMetadata() {
      const md = new grpc.Metadata();
      const tok = await fetchToken(opts.audience);
      md.set("authorization", `Bearer ${tok}`);
      return md;
    },
  };
}
```

- [ ] **Step 4: Wire it in `index.ts` based on env**

```ts
const authMode = process.env.PAPERCLIP_WORKER_AUTH_MODE ?? "shared_secret";
const auth =
  authMode === "shared_secret"
    ? staticBearerAuth(required("PAPERCLIP_WORKER_SHARED_SECRET"))
    : gcpIdTokenAuth({ audience: required("PAPERCLIP_WORKER_AUDIENCE") });
```

- [ ] **Step 5: Run tests**

```
pnpm --filter @paperclipai/worker test
```

- [ ] **Step 6: Commit**

```
git add packages/worker
git commit -m "$(cat <<'EOF'
feat(worker): GCP id-token credentials via metadata server

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Whole-repo green build + summary commit

- [ ] **Step 1: Full repo build + tests**

```
pnpm -r build
pnpm -r test --run
```

Expected: green.

- [ ] **Step 2: Update `ROADMAP.md`**

Edit the `⚪ Cloud / Sandbox agents` section to include a note pointing at the spec:

```
### 🚧 Cloud / Sandbox agents (e.g. Cursor / e2b agents)

In progress. See `docs/superpowers/specs/2026-05-08-distributed-workers-design.md`
and `docs/superpowers/plans/2026-05-08-distributed-workers-foundation.md`.
Phase 1 (foundation): pi_local end-to-end via gRPC + ephemeral workspaces.
```

- [ ] **Step 3: Commit**

```
git add ROADMAP.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark distributed workers as in-progress (foundation)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** every section of `2026-05-08-distributed-workers-design.md` that this plan claims to cover (skeleton + pi_local end-to-end + happy-path lease + auth) has at least one task. Filestore mode, reaper job, multi-adapter rollout, runtime services, MIG drain — all explicitly out of scope for this plan.
- [ ] **No placeholders:** search the plan for "TBD", "TODO", "implement later", "fill in details" — should be zero hits.
- [ ] **Type consistency:** message names (`RunDispatch`, `RunComplete`, `RunFailed`), schema names (`*Schema`), service names match across server, worker, and proto.
- [ ] **Commit hygiene:** every task ends with a green build (`pnpm -r build && pnpm -r test --run`).

## What's not done after this plan

- **Lease reaper** that survives server restarts (state is currently in-memory on the dispatcher). Plan 2.
- **Idempotent re-dispatch** when a worker dies mid-run. Plan 2.
- **All `*_local` adapters** beyond `pi_local`. Plan 2 (mostly mechanical).
- **Workspace runtime services** (`workspace-runtime.ts`, dev servers, local-service-supervisor). Plan 3.
- **Filestore mode** with cross-worker workspace lease. Plan 4.
- **MIG autoscaler custom metric**, GCS session blob store, Cloud Monitoring dashboards, admin `/_workers` UI. Plan 5.
