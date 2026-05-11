import { z } from "zod";

export const manualSignoffSchema = z.object({
  name: z.string().min(1),
  required_role: z.string().optional(),
  auto_reopen_on_revert: z.boolean().optional(),
});
