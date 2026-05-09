import { describe, expect, it } from "vitest";
import { computeSalience, SALIENCE_FLOOR } from "../salience.js";

const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("computeSalience", () => {
  it("returns approximately the current value when fresh and untouched", () => {
    const out = computeSalience({
      createdAt: new Date(),
      lastUsedAt: null,
      useCount: 0,
      currentSalience: 0.5,
    });
    expect(out).toBeCloseTo(0.5, 2);
  });

  it("halves toward floor over the 14-day half-life when unused", () => {
    const out = computeSalience({
      createdAt: day(14),
      lastUsedAt: null,
      useCount: 0,
      currentSalience: 0.5,
    });
    // 0.5 * 0.5 = 0.25
    expect(out).toBeCloseTo(0.25, 2);
  });

  it("never drops below the floor", () => {
    const out = computeSalience({
      createdAt: day(365 * 5),
      lastUsedAt: null,
      useCount: 0,
      currentSalience: 0.5,
    });
    expect(out).toBe(SALIENCE_FLOOR);
  });

  it("recent recall keeps salience warm via lastUsedAt anchor", () => {
    const out = computeSalience({
      createdAt: day(60),
      lastUsedAt: new Date(), // touched just now
      useCount: 1,
      currentSalience: 0.5,
    });
    // Decay near 1, plus a small use boost.
    expect(out).toBeGreaterThan(0.5);
  });

  it("use boost is logarithmic and capped", () => {
    const tenUses = computeSalience({
      createdAt: new Date(),
      lastUsedAt: new Date(),
      useCount: 10,
      currentSalience: 0.5,
    });
    const hundredUses = computeSalience({
      createdAt: new Date(),
      lastUsedAt: new Date(),
      useCount: 100,
      currentSalience: 0.5,
    });
    expect(hundredUses).toBeGreaterThan(tenUses);
    expect(hundredUses).toBeLessThanOrEqual(1);
  });

  it("clamps at 1.0", () => {
    const out = computeSalience({
      createdAt: new Date(),
      lastUsedAt: new Date(),
      useCount: 1_000_000,
      currentSalience: 0.95,
    });
    expect(out).toBeLessThanOrEqual(1);
  });
});
