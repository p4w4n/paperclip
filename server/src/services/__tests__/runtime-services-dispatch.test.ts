// Plan 3 dispatch projection: takes already-resolved runtime service
// entries from workspace-runtime.ts (selectRuntimeServiceEntries +
// resolveServiceScopeId) plus a realized workspace + adapter env, and
// produces the RuntimeServiceSpec[] payload for the proto frame.
//
// Pure function — no DB, no spawn. The caller is responsible for
// resolving the entries and passing them in.

import { describe, it, expect } from "vitest";
import { buildRuntimeServiceSpecs, type ResolvedRuntimeServiceEntry } from "../runtime-services-dispatch.js";

const realizedCwd = "/tmp/wkspace";
const baseEnv: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin", HOME: "/paperclip" };

function entry(input: Partial<ResolvedRuntimeServiceEntry>): ResolvedRuntimeServiceEntry {
  return {
    runtimeServiceId: input.runtimeServiceId ?? "rsid-1",
    serviceName: input.serviceName ?? "dev",
    command: input.command ?? "npm run dev",
    cwd: input.cwd,
    env: input.env ?? {},
    readyPort: input.readyPort,
    readyHealthcheckUrl: input.readyHealthcheckUrl,
    readinessTimeoutSec: input.readinessTimeoutSec,
  };
}

describe("buildRuntimeServiceSpecs", () => {
  it("translates a single entry into a single spec, merging env", async () => {
    const specs = buildRuntimeServiceSpecs({
      entries: [
        entry({
          serviceName: "dev",
          command: "npm run dev",
          env: { NODE_ENV: "development" },
          readyPort: 3000,
          readinessTimeoutSec: 90,
        }),
      ],
      workspaceCwd: realizedCwd,
      adapterEnv: baseEnv,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].serviceName).toBe("dev");
    expect(specs[0].command).toBe("npm run dev");
    expect(specs[0].cwd).toBe(realizedCwd);
    expect(specs[0].env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(specs[0].env.NODE_ENV).toBe("development");
    expect(specs[0].readyPort).toBe(3000);
    expect(specs[0].readinessTimeoutSec).toBe(90);
  });

  it("preserves order across multiple entries", () => {
    const specs = buildRuntimeServiceSpecs({
      entries: [
        entry({ runtimeServiceId: "a", serviceName: "db" }),
        entry({ runtimeServiceId: "b", serviceName: "api" }),
        entry({ runtimeServiceId: "c", serviceName: "ui" }),
      ],
      workspaceCwd: realizedCwd,
      adapterEnv: baseEnv,
    });
    expect(specs.map((s) => s.serviceName)).toEqual(["db", "api", "ui"]);
  });

  it("entry-level env overrides adapter env on conflict", () => {
    const specs = buildRuntimeServiceSpecs({
      entries: [
        entry({ env: { PATH: "/opt/bin" } }),
      ],
      workspaceCwd: realizedCwd,
      adapterEnv: baseEnv,
    });
    expect(specs[0].env.PATH).toBe("/opt/bin");
  });

  it("entry cwd overrides workspace cwd when supplied", () => {
    const specs = buildRuntimeServiceSpecs({
      entries: [
        entry({ cwd: "/tmp/wkspace/api" }),
      ],
      workspaceCwd: realizedCwd,
      adapterEnv: baseEnv,
    });
    expect(specs[0].cwd).toBe("/tmp/wkspace/api");
  });

  it("missing readiness signals → ready_port=0 ready_healthcheck_url='' (worker treats as PID-only)", () => {
    const specs = buildRuntimeServiceSpecs({
      entries: [entry({})],
      workspaceCwd: realizedCwd,
      adapterEnv: baseEnv,
    });
    expect(specs[0].readyPort).toBe(0);
    expect(specs[0].readyHealthcheckUrl).toBe("");
    expect(specs[0].readinessTimeoutSec).toBe(0); // 0 = use worker default
  });
});
