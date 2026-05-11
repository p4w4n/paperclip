import { z } from "zod";

export const planCompletedSchema = z.object({
  name: z.string().min(1),
  plan_id: z.string().uuid().optional(),
  auto_reopen_on_revert: z.boolean().optional(),
});
