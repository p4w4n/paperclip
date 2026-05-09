import { describe, expect, it } from "vitest";
import { checkExitCriteria } from "../run-completion-hook.js";

describe("checkExitCriteria", () => {
  it("met when no criteria", () => {
    expect(checkExitCriteria(null, "anything")).toBe(true);
    expect(checkExitCriteria("", "anything")).toBe(true);
  });

  it("met when criteria has only checked items", () => {
    expect(checkExitCriteria("- [x] done\n- [X] also done", null)).toBe(true);
  });

  it("not met when summary missing + unchecked items present", () => {
    expect(checkExitCriteria("- [ ] write tests", null)).toBe(false);
  });

  it("met when summary mentions every unchecked item", () => {
    expect(
      checkExitCriteria(
        "- [ ] write tests\n- [ ] update docs",
        "I added tests for the new flow and updated DOCS sections.",
      ),
    ).toBe(false); // 'docs' lowercase matches 'DOCS' but the text 'update docs' substring isn't there

    // Try a substring that exactly matches.
    expect(
      checkExitCriteria(
        "- [ ] write tests\n- [ ] update docs",
        "ran write tests and update docs",
      ),
    ).toBe(true);
  });
});
