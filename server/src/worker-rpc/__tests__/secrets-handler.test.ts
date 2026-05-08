import { describe, it, expect, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { FetchSecretsRequestSchema } from "@paperclipai/worker-rpc";
import { handleFetchSecrets, type SecretsHandlerDeps } from "../secrets-handler.js";

describe("handleFetchSecrets", () => {
  it("returns secrets for a valid scope token", async () => {
    const lookupAndInvalidate = vi.fn(async (token: string) => {
      if (token === "secrets:r-1") return { OPENAI_API_KEY: "k" };
      throw new Error("unknown token");
    });
    const resp = await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "secrets:r-1", scopedJwt: "ignored" }),
      { lookupAndInvalidate } as SecretsHandlerDeps,
    );
    expect(resp.secrets["OPENAI_API_KEY"]).toBe("k");
  });

  it("throws on invalid token", async () => {
    const lookupAndInvalidate = vi.fn(async () => {
      throw new Error("bad");
    });
    await expect(
      handleFetchSecrets(
        create(FetchSecretsRequestSchema, { scopeToken: "bad", scopedJwt: "" }),
        { lookupAndInvalidate } as SecretsHandlerDeps,
      ),
    ).rejects.toThrow("bad");
  });

  it("ignores scoped_jwt field (spec D2)", async () => {
    const lookupAndInvalidate = vi.fn(async () => ({ K: "v" }));
    await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "ok", scopedJwt: "anything-here-is-ignored" }),
      { lookupAndInvalidate } as SecretsHandlerDeps,
    );
    expect(lookupAndInvalidate).toHaveBeenCalledWith("ok");
  });

  it("token cannot be reused (one-time)", async () => {
    const consumed = new Set<string>();
    const lookupAndInvalidate = vi.fn(async (token: string) => {
      if (consumed.has(token)) throw new Error("token already consumed");
      consumed.add(token);
      return { K: "v" };
    });
    await handleFetchSecrets(
      create(FetchSecretsRequestSchema, { scopeToken: "once", scopedJwt: "" }),
      { lookupAndInvalidate } as SecretsHandlerDeps,
    );
    await expect(
      handleFetchSecrets(
        create(FetchSecretsRequestSchema, { scopeToken: "once", scopedJwt: "" }),
        { lookupAndInvalidate } as SecretsHandlerDeps,
      ),
    ).rejects.toThrow("already consumed");
  });
});
