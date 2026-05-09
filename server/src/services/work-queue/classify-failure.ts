// Pure mapping (errorCode, errorMessage) → RetryClass.
//
// Sources of truth:
//   - errorCode (string code emitted by adapter or scheduler) is
//     the strong signal; use it first.
//   - errorMessage is a soft fallback — the regex check absorbs
//     errors that surface text-only (network blips, timeouts).
//
// Order matters: poison checks come BEFORE quota_exceeded and the
// transient checks because a poison signal should never be retried.

import type { RetryClass } from "./types.js";

export interface ClassifyInput {
  errorCode: string | null | undefined;
  errorMessage?: string | null;
}

const TRANSIENT_PROVIDER_CODES = new Set([
  "provider_429",
  "provider_503",
  "network_timeout",
  "rate_limited",
  "service_unavailable",
]);

const TRANSIENT_LOCAL_CODES = new Set([
  "lease_expired",
  "worker_drain",
  "runtime_service_failed",
  "worker_died",
]);

const POISON_CODES = new Set([
  "adapter_parse_error",
  "schema_validation_failed",
  "permanent",
  "invalid_input",
]);

const QUOTA_CODES = new Set(["budget_blocked", "quota_exceeded", "spend_cap_hit"]);

const TRANSIENT_MESSAGE_PATTERN = /\b(429|503|504|timeout|timed out|reset|econnreset|fetch failed|network error)\b/i;

export function classifyFailure(input: ClassifyInput): RetryClass {
  const code = (input.errorCode ?? "").trim().toLowerCase();
  const message = (input.errorMessage ?? "").trim();

  if (POISON_CODES.has(code)) return "poison";
  if (code.endsWith("_permanent")) return "permanent";
  if (QUOTA_CODES.has(code)) return "quota_exceeded";
  if (TRANSIENT_LOCAL_CODES.has(code)) return "transient_local";
  if (TRANSIENT_PROVIDER_CODES.has(code)) return "transient_provider";

  // Fallback: text scan.
  if (TRANSIENT_MESSAGE_PATTERN.test(message)) return "transient_provider";

  // Unknown error; treat as poison (don't burn retries on something
  // we can't classify).
  return "poison";
}
