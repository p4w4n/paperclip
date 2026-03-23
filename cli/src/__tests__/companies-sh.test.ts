import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../companies.sh");

function runEcho(args: string[]) {
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: path.dirname(scriptPath),
    env: {
      ...process.env,
      COMPANIES_SH_ECHO: "1",
    },
    encoding: "utf8",
  }).trim();
}

describe("companies.sh", () => {
  it("passes through positional source imports with current company import ergonomics", () => {
    expect(runEcho([
      "paperclipai/companies/engineering",
      "--target", "existing",
      "-C", "company-123",
      "--dry-run",
    ])).toBe(
      "pnpm paperclipai company import paperclipai/companies/engineering --target existing -C company-123 --dry-run",
    );
  });

  it("accepts the optional import verb", () => {
    expect(runEcho([
      "import",
      "./exports/acme",
      "--include", "agents,skills",
      "--collision", "rename",
    ])).toBe(
      "pnpm paperclipai company import ./exports/acme --include agents\\,skills --collision rename",
    );
  });

  it("normalizes legacy --from usage into the positional source argument", () => {
    expect(runEcho([
      "--from", "https://github.com/org/repo/tree/main/acme",
      "--ref", "release/2026-03-23",
      "--yes",
    ])).toBe(
      "pnpm paperclipai company import https://github.com/org/repo/tree/main/acme --ref release/2026-03-23 --yes",
    );
  });

  it("supports --from=value compatibility", () => {
    expect(runEcho([
      "--from=org/repo/company-template",
      "--paperclip-url", "http://localhost:3100",
      "--json",
    ])).toBe(
      "pnpm paperclipai company import org/repo/company-template --paperclip-url http://localhost:3100 --json",
    );
  });

  it("fails when no source path or URL is provided", () => {
    const result = spawnSync("bash", [scriptPath, "--dry-run"], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        COMPANIES_SH_ECHO: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source path or URL is required");
  });
});
