import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacInput {
  secret: string;
  rawBody: string;
  providedSig: string;
}

export function verifyHmacSignature(input: HmacInput): boolean {
  if (!input.secret || !input.providedSig) return false;
  const provided = input.providedSig.startsWith("sha256=")
    ? input.providedSig.slice("sha256=".length)
    : input.providedSig;
  const computed = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  if (provided.length !== computed.length) {
    // Length mismatch: return false directly. timingSafeEqual would throw on
    // mismatched lengths, so we cannot route through it here. The early-return
    // is acceptable: the secret length is fixed (sha256 = 64 hex chars), so a
    // length mismatch cannot leak information about the secret itself.
    return false;
  }
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(computed, "hex"));
}
