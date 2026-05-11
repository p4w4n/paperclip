import { z } from "zod";

export const externalSignalSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  auto_reopen_on_revert: z.boolean().optional(),
});
