import { z } from "zod";

export const externalSignalSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
});
