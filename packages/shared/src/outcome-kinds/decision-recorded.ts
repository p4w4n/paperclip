import { z } from "zod";

export const decisionRecordedSchema = z.object({
  name: z.string().min(1),
  plan_id: z.string().uuid(),
  decision_title: z.string().min(1),
  auto_reopen_on_revert: z.boolean().optional(),
});
