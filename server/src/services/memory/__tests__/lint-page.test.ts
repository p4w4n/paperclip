import { describe, expect, it } from "vitest";
import { parseLintResponse } from "../pgvector-wiki-backend.js";

describe("parseLintResponse", () => {
  it("defaults to clean when input is empty/garbage", () => {
    expect(parseLintResponse("")).toEqual({ status: "clean", notes: null, rewrite: null });
    expect(parseLintResponse("just prose")).toEqual({
      status: "clean",
      notes: null,
      rewrite: null,
    });
  });

  it("parses a clean response", () => {
    expect(
      parseLintResponse('{"status":"clean","notes":"matches sources","rewrite":""}'),
    ).toEqual({ status: "clean", notes: "matches sources", rewrite: null });
  });

  it("parses a stale response with rewrite", () => {
    const out = parseLintResponse(
      '{"status":"stale","notes":"version drift","rewrite":"## New content"}',
    );
    expect(out.status).toBe("stale");
    expect(out.rewrite).toBe("## New content");
  });

  it("clamps unknown status values to clean", () => {
    expect(parseLintResponse('{"status":"bogus"}').status).toBe("clean");
  });

  it("tolerates prose around the JSON", () => {
    const out = parseLintResponse('Here you go: {"status":"contradicted","notes":"x"} ok');
    expect(out.status).toBe("contradicted");
    expect(out.notes).toBe("x");
  });

  it("ignores empty rewrite strings", () => {
    expect(parseLintResponse('{"status":"stale","rewrite":""}').rewrite).toBe(null);
    expect(parseLintResponse('{"status":"stale","rewrite":"   "}').rewrite).toBe(null);
  });
});
