#!/usr/bin/env node
// seed-heartbeat-runs.mjs — bulk-insert ~5,000 synthetic heartbeat_runs into
// the seeded company so the harness can exercise the unpaginated-fetch path
// described in upstream issue #958 (slow UI from unbounded heartbeat-runs
// downloads).
//
// We bypass the API and write directly to embedded postgres via `pg` because:
//   1. Public API only invokes ONE run per call and the queued runs sit
//      forever waiting for an agent process that never exists.
//   2. We need realistic status distribution (succeeded/failed/timed_out/etc.)
//      and historical timestamps spread over ~14 days so the chart-stats
//      query (#959) returns realistic shapes.
//
// Reads the seeded companyId + agentIds from perf/results/seed-state.json.
// Connection details are derived from server/src/index.ts (user/password
// "paperclip", port from the running embedded-pg).
//
// Usage:
//   node perf/seed/seed-heartbeat-runs.mjs
//   COUNT=10000 node perf/seed/seed-heartbeat-runs.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// pg isn't a direct dependency of any workspace package but lives in the
// pnpm store as a transitive dep. Resolve it via createRequire so this
// script works without adding a package.json entry.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pg = require("/tmp/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(HERE, "..", "results", "seed-state.json");

const TARGET_COUNT = Number(process.env.COUNT ?? 5_000);
// Default points at the dedicated /tmp/paperclip-perf-pg cluster, NOT the
// embedded postgres at /tmp/paperclip-perf-home (which has live company data).
// Override via PAPERCLIP_PG_PORT only if you know the target is safe.
const PG_PORT = Number(process.env.PAPERCLIP_PG_PORT ?? 5433);
const PG_USER = process.env.PAPERCLIP_PG_USER ?? "paperclip";
const PG_PASSWORD = process.env.PAPERCLIP_PG_PASSWORD ?? "";
const PG_DB = process.env.PAPERCLIP_PG_DB ?? "paperclip_perf";
const PG_HOST = process.env.PAPERCLIP_PG_HOST ?? "127.0.0.1";

const STATUS_DISTRIBUTION = [
  ["succeeded", 0.55],
  ["failed", 0.12],
  ["timed_out", 0.06],
  ["cancelled", 0.05],
  ["running", 0.05],
  ["queued", 0.04],
  ["adapter_failed", 0.03],
  ["completed_with_warnings", 0.10],
];

function pickStatus(rng) {
  const r = rng();
  let acc = 0;
  for (const [status, prob] of STATUS_DISTRIBUTION) {
    acc += prob;
    if (r < acc) return status;
  }
  return "succeeded";
}

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = Math.imul(48271, s) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`No seed-state.json at ${STATE_FILE}. Run seed-realistic.mjs first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

const state = readState();
const { companyId, agentIds } = state;
if (!companyId || !Array.isArray(agentIds) || agentIds.length === 0) {
  console.error("seed-state.json missing companyId or agentIds.");
  process.exit(1);
}

const client = new pg.Client({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DB });
await client.connect();

const before = await client.query("SELECT count(*)::int AS n FROM heartbeat_runs WHERE company_id = $1", [companyId]);
const have = before.rows[0].n;
if (have >= TARGET_COUNT) {
  console.log(`[hb-seed] already at ${have} runs for company ${companyId}; no-op`);
  await client.end();
  process.exit(0);
}

const need = TARGET_COUNT - have;
console.log(`[hb-seed] inserting ${need} heartbeat_runs (current: ${have}, target: ${TARGET_COUNT})`);

const rand = rng(0xBEEF42);
const NOW = Date.now();
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Postgres bulk-insert via UNNEST is the fastest path. We build column arrays
// then UNNEST them into a single INSERT.
const ids = [];
const agentIdCol = [];
const statuses = [];
const startedAts = [];
const finishedAts = [];
const errors = [];
const errorCodes = [];
const exitCodes = [];
const createdAts = [];
const usageJsons = [];

for (let i = 0; i < need; i++) {
  const offsetMs = Math.floor(rand() * FOURTEEN_DAYS_MS);
  const createdAt = new Date(NOW - offsetMs);
  const startDelay = Math.floor(rand() * 5_000);
  const startedAt = new Date(createdAt.getTime() + startDelay);
  const status = pickStatus(rand);
  const isTerminal = status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "adapter_failed" || status === "completed_with_warnings";
  const finishedAt = isTerminal ? new Date(startedAt.getTime() + Math.floor(rand() * 60_000)) : null;
  const isFailure = status === "failed" || status === "timed_out" || status === "adapter_failed";

  ids.push(crypto.randomUUID());
  agentIdCol.push(agentIds[Math.floor(rand() * agentIds.length)]);
  statuses.push(status);
  startedAts.push(startedAt.toISOString());
  finishedAts.push(finishedAt ? finishedAt.toISOString() : null);
  errors.push(isFailure ? `Synthetic ${status} error #${i}` : null);
  errorCodes.push(isFailure ? `synthetic_${status}` : null);
  exitCodes.push(status === "succeeded" ? 0 : isFailure ? 1 : null);
  createdAts.push(createdAt.toISOString());
  usageJsons.push(JSON.stringify({
    inputTokens: Math.floor(rand() * 4000),
    outputTokens: Math.floor(rand() * 1500),
    costUsd: Number((rand() * 0.5).toFixed(4)),
  }));
}

const CHUNK = 1_000;
let inserted = 0;
const t0 = Date.now();
for (let off = 0; off < ids.length; off += CHUNK) {
  const slice = (arr) => arr.slice(off, off + CHUNK);
  await client.query(
    `INSERT INTO heartbeat_runs (
      id, company_id, agent_id, invocation_source, status,
      started_at, finished_at, error, error_code,
      exit_code, created_at, updated_at, usage_json
    )
    SELECT
      id::uuid, $1::uuid, agent_id::uuid, 'on_demand', status,
      started_at::timestamptz, finished_at::timestamptz, error, error_code,
      exit_code::int, created_at::timestamptz, created_at::timestamptz, usage_json::jsonb
    FROM unnest(
      $2::text[], $3::text[], $4::text[],
      $5::text[], $6::text[], $7::text[], $8::text[],
      $9::int[], $10::text[], $11::text[]
    ) AS t(
      id, agent_id, status,
      started_at, finished_at, error, error_code,
      exit_code, created_at, usage_json
    )`,
    [
      companyId,
      slice(ids),
      slice(agentIdCol),
      slice(statuses),
      slice(startedAts),
      slice(finishedAts),
      slice(errors),
      slice(errorCodes),
      slice(exitCodes),
      slice(createdAts),
      slice(usageJsons),
    ],
  );
  inserted += Math.min(CHUNK, ids.length - off);
  console.log(`[hb-seed] inserted ${inserted}/${need}...`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const after = await client.query("SELECT count(*)::int AS n FROM heartbeat_runs WHERE company_id = $1", [companyId]);
console.log(`[hb-seed] done in ${elapsed}s. Company ${companyId} now has ${after.rows[0].n} heartbeat_runs.`);

await client.end();
