import { describe, expect, it, vi } from "vitest";
import {
  groupDecisionsByCondition,
  type DecisionForAggregation,
} from "../decision-aggregator.js";

const d = (
  id: string,
  title: string,
  chosenOptionId: string,
  options: Array<{ id: string; label: string }>,
): DecisionForAggregation => ({
  id,
  title,
  rationaleMarkdown: null,
  chosenOptionId,
  options,
});

describe("groupDecisionsByCondition", () => {
  it("returns [] for empty input", async () => {
    expect(await groupDecisionsByCondition([])).toEqual([]);
  });

  it("clusters by title token signature; drops singletons", async () => {
    const out = await groupDecisionsByCondition(
      [
        d("d1", "Database choice for analytics", "pg", [
          { id: "pg", label: "Postgres" },
          { id: "ck", label: "Clickhouse" },
        ]),
        d("d2", "Choice of database for analytics", "pg", [
          { id: "pg", label: "Postgres" },
        ]),
        d("d3", "Auth provider selection", "auth0", [
          { id: "auth0", label: "Auth0" },
        ]),
      ],
      { minClusterSize: 2 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].typicalChoice).toBe("Postgres");
    expect(out[0].clusterSize).toBe(2);
  });

  it("LLM result overrides default when present", async () => {
    const llm = {
      generate: vi.fn(async () =>
        '{"condition": "When choosing analytics DB","choice":"Postgres"}',
      ),
    };
    const out = await groupDecisionsByCondition(
      [
        d("d1", "Database for analytics workload", "pg", [{ id: "pg", label: "Postgres" }]),
        d("d2", "Database for analytics workload", "pg", [{ id: "pg", label: "Postgres" }]),
      ],
      { llm, minClusterSize: 2 },
    );
    expect(out[0].conditionSummary).toMatch(/analytics/);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  it("falls back to dominant choice when LLM errors", async () => {
    const llm = {
      generate: vi.fn(async () => {
        throw new Error("rate limit");
      }),
    };
    const out = await groupDecisionsByCondition(
      [
        d("d1", "Db for analytics", "pg", [{ id: "pg", label: "Postgres" }]),
        d("d2", "DB for analytics", "pg", [{ id: "pg", label: "Postgres" }]),
        d("d3", "Db for analytics", "ck", [{ id: "ck", label: "Clickhouse" }]),
      ],
      { llm, minClusterSize: 2 },
    );
    expect(out[0].typicalChoice).toBe("Postgres"); // 2/3 dominant
  });
});
