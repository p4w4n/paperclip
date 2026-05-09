import { describe, expect, it, vi } from "vitest";
import {
  computeSkillDecay,
  extractSkillsFromRun,
  shouldDeleteSkill,
  SKILL_FLOOR,
} from "../skill-miner.js";

describe("extractSkillsFromRun", () => {
  it("returns [] for empty summary", async () => {
    const llm = { generate: vi.fn() };
    expect(await extractSkillsFromRun("", llm)).toEqual([]);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("parses a clean JSON array", async () => {
    const llm = {
      generate: vi.fn(async () => '["typescript-refactor", "postgres-migration"]'),
    };
    const out = await extractSkillsFromRun("Refactored auth in TS + ran a Postgres migration.", llm);
    expect(out).toEqual(["typescript-refactor", "postgres-migration"]);
  });

  it("tolerates prose around the JSON", async () => {
    const llm = {
      generate: vi.fn(async () => 'Sure: ["incident-response"] done.'),
    };
    const out = await extractSkillsFromRun("debugged the outage", llm);
    expect(out).toEqual(["incident-response"]);
  });

  it("returns [] on LLM error", async () => {
    const llm = {
      generate: vi.fn(async () => {
        throw new Error("rate limit");
      }),
    };
    expect(await extractSkillsFromRun("anything", llm)).toEqual([]);
  });

  it("caps at 8 entries + lowercases + dedupes via slice", async () => {
    const arr = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const llm = { generate: vi.fn(async () => JSON.stringify(arr)) };
    const out = await extractSkillsFromRun("x", llm);
    expect(out.length).toBeLessThanOrEqual(8);
  });
});

describe("computeSkillDecay", () => {
  it("no decay when fresh", () => {
    const out = computeSkillDecay({
      confidence: 0.8,
      lastEvidencedAt: new Date(),
    });
    expect(out).toBeCloseTo(0.8, 2);
  });

  it("0.1 per month default rate", () => {
    const oneMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const out = computeSkillDecay({
      confidence: 0.8,
      lastEvidencedAt: oneMonth,
    });
    expect(out).toBeCloseTo(0.7, 2);
  });

  it("clamps at 0", () => {
    const old = new Date(Date.now() - 365 * 5 * 24 * 60 * 60 * 1000);
    expect(computeSkillDecay({ confidence: 0.5, lastEvidencedAt: old })).toBe(0);
  });
});

describe("shouldDeleteSkill", () => {
  it("deletes below floor", () => {
    expect(shouldDeleteSkill(SKILL_FLOOR - 0.001)).toBe(true);
    expect(shouldDeleteSkill(SKILL_FLOOR)).toBe(false);
    expect(shouldDeleteSkill(0.5)).toBe(false);
  });
});
