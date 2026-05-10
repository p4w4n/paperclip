import { z } from "zod";

export const artifactDeclaredSchema = z.object({
  name: z.string().min(1, "name is required"),
  artifact_kind: z.enum([
    "code.file", "code.patch", "doc.markdown", "doc.office",
    "chart", "data.table", "web.app",
  ]),
  name_glob: z.string().optional(),
});
