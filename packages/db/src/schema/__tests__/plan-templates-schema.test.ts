import { describe, expect, it } from "vitest";
import { planTemplates, githubWebhookDeliveries, companies, playbooks } from "../index.js";

describe("plan_templates schema", () => {
  it("exports planTemplates with expected columns", () => {
    expect(Object.keys(planTemplates)).toEqual(
      expect.arrayContaining([
        "id", "companyId", "name", "description",
        "defaultRequiredOutcomes", "defaultPhases", "archivedAt",
        "createdByUserId", "createdByAgentId",
        "createdAt", "updatedAt",
      ]),
    );
  });

  it("exports githubWebhookDeliveries with expected columns", () => {
    expect(Object.keys(githubWebhookDeliveries)).toEqual(
      expect.arrayContaining([
        "id", "companyId", "deliveryId", "eventType", "action",
        "prUrl", "outcomeId", "signatureValid", "result",
        "rawBodySha256", "receivedAt",
      ]),
    );
  });

  it("adds githubWebhookSecret column to companies", () => {
    expect(Object.keys(companies)).toContain("githubWebhookSecret");
  });

  it("adds suggestedOutcomes column to playbooks", () => {
    expect(Object.keys(playbooks)).toContain("suggestedOutcomes");
  });
});
