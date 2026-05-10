import { z } from "zod";

export const approvalGrantedSchema = z.object({
  name: z.string().min(1),
  approval_kind: z.string().min(1),
});
