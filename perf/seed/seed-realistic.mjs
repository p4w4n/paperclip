#!/usr/bin/env node
// seed-realistic.mjs — populate a freshly-onboarded Paperclip instance with
// enough data that idle-polling, tab-refocus, and ws-burst measurements
// reflect real dashboard behaviour rather than the empty-state animation.
//
// Default seed: 1 company, 30 agents (variety of roles/adapters), 0 issues.
// Issues with chat history are deferred — the existing
// /tests/perf/long-thread fixture already exercises chat-thread perf, so the
// seed only needs to give the sidebar/dashboard something to render and poll.
//
// Usage:
//   PAPERCLIP_PERF_BASE_URL=http://localhost:5001 node perf/seed/seed-realistic.mjs
//
// Output:
//   perf/results/seed-state.json  — { companyId, agentIds[], createdAt }
//   stdout: brief progress log
//
// Idempotent on re-run: looks for an existing "Perf Co" company and reuses
// it. Will not duplicate agents — checks count and only tops up to the
// target.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERF_ROOT = path.resolve(HERE, "..");
const BASE_URL = (process.env.PAPERCLIP_PERF_BASE_URL || "http://localhost:5001").replace(/\/$/, "");
const COMPANY_NAME = process.env.PAPERCLIP_PERF_COMPANY_NAME || "Perf Co";
const TARGET_AGENT_COUNT = Number(process.env.PAPERCLIP_PERF_AGENT_COUNT ?? 30);

const ROLES = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"];
const ADAPTERS = ["process", "claude_local", "codex_local", "cursor"];
const FIRST_NAMES = ["Ada", "Alan", "Grace", "Linus", "Ken", "Brian", "Dennis", "Bjarne", "Donald", "John", "Margaret", "Hedy", "Edsger", "Tony", "Niklaus", "Anders", "Yukihiro", "Guido", "James", "Brendan"];
const SURNAMES = ["Bot", "Agent", "Worker", "Helper", "Pilot", "Engineer", "Mind"];

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function findOrCreateCompany() {
  const all = await api("GET", "/api/companies");
  const existing = (Array.isArray(all) ? all : all?.companies ?? []).find((c) => c?.name === COMPANY_NAME);
  if (existing) {
    console.log(`[seed] reusing existing company: ${COMPANY_NAME} (${existing.id})`);
    return existing;
  }
  const created = await api("POST", "/api/companies", {
    name: COMPANY_NAME,
    description: "Synthetic company for performance baseline measurements.",
    budgetMonthlyCents: 1_000_000,
  });
  console.log(`[seed] created company: ${COMPANY_NAME} (${created.id})`);
  return created;
}

async function listAgents(companyId) {
  const r = await api("GET", `/api/companies/${companyId}/agents`);
  return Array.isArray(r) ? r : r?.agents ?? [];
}

function rng(seed) {
  // Deterministic PRNG so re-seed produces identical names/roles when topping up.
  let s = seed | 0;
  return () => {
    s = Math.imul(48271, s) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

async function ensureAgents(companyId, target) {
  const existing = await listAgents(companyId);
  const have = existing.length;
  if (have >= target) {
    console.log(`[seed] already at ${have} agents (target ${target}); no-op`);
    return existing.map((a) => a.id);
  }
  const rand = rng(0xC0FFEE);
  const created = [];
  for (let i = have; i < target; i++) {
    const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
    const surname = SURNAMES[Math.floor(rand() * SURNAMES.length)];
    const role = ROLES[i % ROLES.length];
    const adapterType = ADAPTERS[i % ADAPTERS.length];
    const name = `${first} ${surname} ${i + 1}`;
    const agent = await api("POST", `/api/companies/${companyId}/agents`, {
      name,
      role,
      adapterType,
      budgetMonthlyCents: 5_000 + Math.floor(rand() * 50_000),
      capabilities: `Synthetic ${role} agent created by perf seed.`,
    });
    created.push(agent.id);
    if ((i + 1) % 5 === 0) console.log(`[seed] created ${created.length}/${target - have} agents...`);
  }
  console.log(`[seed] created ${created.length} agents (now ${have + created.length} total)`);
  return [...existing.map((a) => a.id), ...created];
}

const company = await findOrCreateCompany();
const agentIds = await ensureAgents(company.id, TARGET_AGENT_COUNT);

const stateFile = path.join(PERF_ROOT, "results", "seed-state.json");
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({
  companyId: company.id,
  companyName: company.name,
  agentIds,
  agentCount: agentIds.length,
  createdAt: new Date().toISOString(),
}, null, 2));

console.log(`[seed] wrote ${path.relative(PERF_ROOT, stateFile)}`);
console.log(`[seed] companyId=${company.id} agents=${agentIds.length}`);
