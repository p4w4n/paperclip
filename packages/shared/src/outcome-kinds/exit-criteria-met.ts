import { z } from "zod";

export const exitCriteriaMetSchema = z.object({
  name: z.string().min(1),
  plan_phase_id: z.string().uuid(),
  auto_reopen_on_revert: z.boolean().optional(),
});
