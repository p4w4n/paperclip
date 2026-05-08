// The supervisor is a thin spawn/track/stop layer. We test against
// real child processes (no mocks) — Node's child_process is the
// behavior we're depending on, mocking it would just double-test
// our own wrapper. Tests exit ESRCH-clean by stopping every started
// process in afterEach.

import { describe, it, expect, afterEach } from "vitest";
import { createServicesSupervisor, type ServicesSupervisor } from "../services-supervisor.js";

describe("createServicesSupervisor", () => {
  let sup: ServicesSupervisor;

  afterEach(async () => {
    if (sup) await sup.stopAll();
  });

  it("starts a service and tracks it by runtimeServiceId", async () => {
    sup = createServicesSupervisor();
    const handle = sup.start({
      runId: "r1",
      runtimeServiceId: "s1",
      command: "node -e 'setInterval(()=>{}, 1000)'",
      cwd: "/tmp",
      env: {},
    });
    expect(handle.pid).toBeGreaterThan(0);
    expect(sup.list().map((h) => h.runtimeServiceId)).toEqual(["s1"]);
  });

  it("stop() kills the underlying process", async () => {
    sup = createServicesSupervisor();
    const handle = sup.start({
      runId: "r1",
      runtimeServiceId: "s1",
      command: "node -e 'setInterval(()=>{}, 1000)'",
      cwd: "/tmp",
      env: {},
    });
    const pid = handle.pid;
    await sup.stop("s1");
    // Allow the OS a moment to actually reap.
    await new Promise((r) => setTimeout(r, 100));
    // process.kill(pid, 0) probes liveness; ESRCH means the process is gone.
    let aliveAfter = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      aliveAfter = (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(aliveAfter).toBe(false);
    expect(sup.list()).toHaveLength(0);
  });

  it("stopAllFor(runId) only stops services for that run", async () => {
    sup = createServicesSupervisor();
    sup.start({
      runId: "r1",
      runtimeServiceId: "s1",
      command: "node -e 'setInterval(()=>{}, 1000)'",
      cwd: "/tmp",
      env: {},
    });
    sup.start({
      runId: "r2",
      runtimeServiceId: "s2",
      command: "node -e 'setInterval(()=>{}, 1000)'",
      cwd: "/tmp",
      env: {},
    });
    await sup.stopAllFor("r1");
    expect(sup.list().map((h) => h.runtimeServiceId)).toEqual(["s2"]);
  });

  it("closed promise resolves when the process exits naturally", async () => {
    sup = createServicesSupervisor();
    const handle = sup.start({
      runId: "r1",
      runtimeServiceId: "s1",
      // Exits immediately — the promise should resolve fast.
      command: "node -e 'process.exit(0)'",
      cwd: "/tmp",
      env: {},
    });
    await handle.closed;
    // After natural exit the supervisor should have cleared the entry.
    expect(sup.list()).toHaveLength(0);
  });

  it("env is passed to the child", async () => {
    sup = createServicesSupervisor();
    const handle = sup.start({
      runId: "r1",
      runtimeServiceId: "s1",
      // Echo a marker only present if PAPERCLIP_TEST_MARK reached the child.
      // We assert via the closed promise's exit code (via the handle's
      // exit accessor below — set after closed resolves).
      command:
        "node -e 'process.exit(process.env.PAPERCLIP_TEST_MARK === \"yes\" ? 0 : 7)'",
      cwd: "/tmp",
      env: { PAPERCLIP_TEST_MARK: "yes" },
    });
    await handle.closed;
    expect(handle.exitCode).toBe(0);
  });
});
