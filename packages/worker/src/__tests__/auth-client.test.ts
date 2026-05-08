import { describe, it, expect, vi } from "vitest";
import { staticBearerAuth, gcpIdTokenAuth } from "../auth-client.js";

describe("staticBearerAuth", () => {
  it("returns the configured bearer token", async () => {
    const c = staticBearerAuth("hello");
    const md = await c.getMetadata();
    expect(md.get("authorization")).toEqual(["Bearer hello"]);
  });
});

describe("gcpIdTokenAuth", () => {
  it("fetches an id-token and sets bearer header", async () => {
    const fetchToken = vi.fn(async () => "id-token-abc");
    const c = gcpIdTokenAuth({ audience: "https://x", fetchToken });
    const md = await c.getMetadata();
    expect(md.get("authorization")).toEqual(["Bearer id-token-abc"]);
    expect(fetchToken).toHaveBeenCalledWith("https://x");
  });

  it("re-fetches per call so an expired token is refreshed", async () => {
    let i = 0;
    const fetchToken = vi.fn(async () => `tok-${++i}`);
    const c = gcpIdTokenAuth({ audience: "https://x", fetchToken });
    const md1 = await c.getMetadata();
    const md2 = await c.getMetadata();
    expect(md1.get("authorization")).toEqual(["Bearer tok-1"]);
    expect(md2.get("authorization")).toEqual(["Bearer tok-2"]);
  });

  it("propagates fetch failure", async () => {
    const fetchToken = vi.fn(async () => {
      throw new Error("metadata unreachable");
    });
    const c = gcpIdTokenAuth({ audience: "https://x", fetchToken });
    await expect(c.getMetadata()).rejects.toThrow(/metadata unreachable/);
  });
});
