// Shared Chromium launch + CDP throttle setup. Determinism is everything for
// before/after numbers, so every scenario goes through this helper to apply
// identical CPU throttling, viewport, and timezone.
//
// Defaults model a "median dev laptop on a slightly stressed CPU" — slow
// enough to expose regressions, fast enough that the harness completes in CI.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  viewport: { width: 1440, height: 1000 },
  cpuThrottlingRate: Number(process.env.PAPERCLIP_PERF_CPU_THROTTLE ?? 4),
  timezoneId: "Asia/Kolkata",
};

export async function launch({ extraArgs = [] } = {}) {
  return chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...extraArgs,
    ],
  });
}

export async function newPerfPage(browser, { extraHeaders } = {}) {
  const context = await browser.newContext({
    viewport: DEFAULTS.viewport,
    timezoneId: DEFAULTS.timezoneId,
    extraHTTPHeaders: extraHeaders,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: DEFAULTS.cpuThrottlingRate });
  return { context, page, cdp };
}

// Reuses the same auth-loading logic as scripts/measure-issue-chat-long-thread.mjs
// so the harness "just works" against a logged-in dev instance.
export function loadBoardToken(originUrl) {
  const fromEnv = process.env.PAPERCLIP_PERF_BEARER_TOKEN;
  if (fromEnv) return fromEnv;
  const authPath = path.resolve(os.homedir(), ".paperclip/auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const credentials = auth.credentials || {};
    const matching = Object.values(credentials).find((entry) => {
      if (!entry || !entry.token || !entry.apiBase) return false;
      return new URL(entry.apiBase).origin === originUrl;
    });
    if (matching?.token) return matching.token;
    const fallback = Object.values(credentials).find((entry) => entry?.token);
    return fallback?.token ?? null;
  } catch {
    return null;
  }
}

export async function attachBearer(page, originUrl, token) {
  if (!token) return;
  await page.route(`${originUrl}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), Authorization: `Bearer ${token}` },
    });
  });
}

export function baseUrl() {
  return (process.env.PAPERCLIP_PERF_BASE_URL || "http://localhost:3100").replace(/\/$/, "");
}
