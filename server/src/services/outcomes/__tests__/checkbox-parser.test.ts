import { describe, expect, it } from "vitest";
import { parseCheckboxes } from "../checkbox-parser.js";

describe("parseCheckboxes", () => {
  it("counts checked vs unchecked", () => {
    const md = `
- [x] one
- [ ] two
- [X] three
- [ ] four
`;
    const r = parseCheckboxes(md);
    expect(r.total).toBe(4);
    expect(r.checked).toBe(2);
    expect(r.allChecked).toBe(false);
  });

  it("returns allChecked=true only when total > 0 and checked == total", () => {
    expect(parseCheckboxes("- [x] one\n- [x] two").allChecked).toBe(true);
    expect(parseCheckboxes("- [ ] one").allChecked).toBe(false);
    expect(parseCheckboxes("").allChecked).toBe(false); // empty = NOT verified
    expect(parseCheckboxes("no checkboxes here").allChecked).toBe(false);
  });

  it("ignores indented or escaped lines that aren't real list items", () => {
    expect(parseCheckboxes("`- [x] not a list`").total).toBe(0);
  });
});
