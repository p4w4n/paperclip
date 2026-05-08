import { describe, it, expect } from "vitest";
import {
  sharedSecretAuthStrategy,
  gcpIdTokenAuthStrategy,
  type IdTokenVerifierLike,
  type WorkerAuthStrategy,
} from "../auth.js";

describe("sharedSecretAuthStrategy", () => {
  const strat: WorkerAuthStrategy = sharedSecretAuthStrategy({ secret: "s3cret" });

  it("accepts a matching bearer token", async () => {
    const result = await strat.verify("Bearer s3cret");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe("shared_secret");
  });

  it("rejects mismatched secret", async () => {
    const result = await strat.verify("Bearer wrong");
    expect(result.ok).toBe(false);
  });

  it("rejects missing bearer prefix", async () => {
    const result = await strat.verify("s3cret");
    expect(result.ok).toBe(false);
  });
});

describe("gcpIdTokenAuthStrategy", () => {
  // Stand-in for google-auth-library's OAuth2Client.verifyIdToken. Returns
  // a LoginTicket-shaped object whose getPayload yields the JWT claims —
  // critically `email`, which we allow-list against.
  const verifier: IdTokenVerifierLike = {
    async verifyIdToken({ idToken }) {
      if (idToken === "bad") throw new Error("invalid");
      return {
        getPayload: () => ({
          email: "paperclip-worker@proj.iam.gserviceaccount.com",
          aud: "https://paperclip/workers",
          iss: "https://accounts.google.com",
        }),
      };
    },
  };

  it("accepts a valid id-token signed by an allow-listed SA", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["paperclip-worker@proj.iam.gserviceaccount.com"],
      verifier,
    });
    const r = await strat.verify("Bearer good");
    expect(r.ok).toBe(true);
    if (r.ok && r.principal.kind === "gcp_id_token") {
      expect(r.principal.saEmail).toBe("paperclip-worker@proj.iam.gserviceaccount.com");
    }
  });

  it("rejects an SA not in the allowlist", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["someone-else@proj.iam.gserviceaccount.com"],
      verifier,
    });
    const r = await strat.verify("Bearer good");
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid token (verifier throws)", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["paperclip-worker@proj.iam.gserviceaccount.com"],
      verifier,
    });
    const r = await strat.verify("Bearer bad");
    expect(r.ok).toBe(false);
  });

  it("rejects missing bearer prefix", async () => {
    const strat = gcpIdTokenAuthStrategy({
      audience: "https://paperclip/workers",
      saAllowlist: ["paperclip-worker@proj.iam.gserviceaccount.com"],
      verifier,
    });
    const r = await strat.verify("good");
    expect(r.ok).toBe(false);
  });
});
