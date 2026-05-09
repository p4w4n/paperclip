import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPokeListeners, onPoke, pokeScheduler } from "../poke.js";

afterEach(() => {
  clearPokeListeners();
});

describe("pokeScheduler", () => {
  it("invokes registered listeners", () => {
    const fn = vi.fn();
    onPoke(fn);
    pokeScheduler("co-1");
    expect(fn).toHaveBeenCalledWith("co-1");
  });

  it("debounces within the window", () => {
    const fn = vi.fn();
    onPoke(fn);
    // Start at a very large fake-now so we beat any prior real-time
    // poke that may have stamped this companyId.
    let now = 10_000_000_000_000;
    expect(pokeScheduler("co-debounce-x", { now: () => now })).toBe(true);
    now += 500;
    expect(pokeScheduler("co-debounce-x", { now: () => now })).toBe(false);
    now += 1000; // total +1500 from the first poke
    expect(pokeScheduler("co-debounce-x", { now: () => now })).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("debounce is per-company", () => {
    const fn = vi.fn();
    onPoke(fn);
    const now = 10_000_000_000_001;
    pokeScheduler("co-per-A-x", { now: () => now });
    pokeScheduler("co-per-B-x", { now: () => now });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("listener errors don't escape", () => {
    onPoke(() => {
      throw new Error("oops");
    });
    expect(() => pokeScheduler("co-1")).not.toThrow();
  });
});
