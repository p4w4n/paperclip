import { describe, it, expect } from "vitest";
import { staticBearerAuth } from "../auth-client.js";

describe("staticBearerAuth", () => {
  it("returns the configured bearer token", async () => {
    const c = staticBearerAuth("hello");
    const md = await c.getMetadata();
    expect(md.get("authorization")).toEqual(["Bearer hello"]);
  });
});
