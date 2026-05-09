import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPokeListeners, onPoke, pokeScheduler } from "../poke.js";

afterEach(() => clearPokeListeners());

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
    let now = 0;
    expect(pokeScheduler("co-1", { now: () => now })).toBe(true);
    now = 500;
    expect(pokeScheduler("co-1", { now: () => now })).toBe(false);
    now = 1500;
    expect(pokeScheduler("co-1", { now: () => now })).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("debounce is per-company", () => {
    const fn = vi.fn();
    onPoke(fn);
    let now = 0;
    pokeScheduler("co-1", { now: () => now });
    pokeScheduler("co-2", { now: () => now });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("listener errors don't escape", () => {
    onPoke(() => {
      throw new Error("oops");
    });
    expect(() => pokeScheduler("co-1")).not.toThrow();
  });
});
