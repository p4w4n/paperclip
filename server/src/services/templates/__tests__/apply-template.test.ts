import { describe, expect, it } from "vitest";
import { projectTemplateToContract } from "../apply-template.js";

describe("projectTemplateToContract", () => {
  it("deep-clones default_required_outcomes so callers can't mutate the template", () => {
    const template = {
      defaultRequiredOutcomes: [
        { kind: "manual_signoff", requiredMeta: { name: "ack" } },
      ],
    };
    const projected = projectTemplateToContract(template as any);
    expect(projected).toEqual(template.defaultRequiredOutcomes);
    expect(projected).not.toBe(template.defaultRequiredOutcomes);
    (projected[0] as any).requiredMeta.name = "MUTATED";
    expect((template.defaultRequiredOutcomes[0] as any).requiredMeta.name).toBe("ack");
  });

  it("returns empty array when default_required_outcomes is empty", () => {
    expect(projectTemplateToContract({ defaultRequiredOutcomes: [] } as any)).toEqual([]);
  });

  it("preserves alternatives field through the projection", () => {
    const template = {
      defaultRequiredOutcomes: [
        {
          kind: "external_signal",
          requiredMeta: { name: "ci", source: "x" },
          alternatives: [{ kind: "manual_signoff", requiredMeta: { required_role: "ops" } }],
        },
      ],
    };
    const projected = projectTemplateToContract(template as any);
    expect((projected[0] as any).alternatives).toHaveLength(1);
  });
});
