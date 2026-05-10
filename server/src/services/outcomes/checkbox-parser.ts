const RE = /^[\s>]*[-*+]\s+\[([ xX])\]\s/gm;

export interface CheckboxCount {
  total: number;
  checked: number;
  allChecked: boolean;
}

export function parseCheckboxes(markdown: string): CheckboxCount {
  let total = 0;
  let checked = 0;
  for (const m of markdown.matchAll(RE)) {
    total++;
    if (m[1] === "x" || m[1] === "X") checked++;
  }
  return { total, checked, allChecked: total > 0 && checked === total };
}
