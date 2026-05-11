import { z } from "zod";

export const approvalGrantedSchema = z.object({
  name: z.string().min(1),
  approval_kind: z.string().min(1),
  auto_reopen_on_revert: z.boolean().optional(),
});
