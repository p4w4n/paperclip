/**
 * Dynamic UI parser loading for external adapters.
 *
 * When the Paperclip UI encounters an adapter type that doesn't have a
 * built-in parser (e.g., an external adapter loaded via the plugin system),
 * it fetches the parser JS from `/api/adapters/:type/ui-parser.js` and
 * evaluates it to create a `parseStdoutLine` function.
 *
 * The parser module must export:
 *   - `parseStdoutLine(line: string, ts: string): TranscriptEntry[]`
 *   - optionally `createStdoutParser(): { parseLine, reset }` for stateful parsers
 *
 * This is the bridge between the server-side plugin system and the client-side
 * UI rendering. Adapter developers ship a `dist/ui-parser.js` with zero
 * runtime dependencies, and Paperclip's UI loads it on demand.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { StdoutLineParser } from "./types";

// Cache of dynamically loaded parsers by adapter type.
// Once loaded, the parser is reused for all runs of that adapter type.
const dynamicParserCache = new Map<string, StdoutLineParser>();

// Track which types we've already attempted to load (to avoid repeat 404s).
const failedLoads = new Set<string>();

/**
 * Dynamically load a UI parser for an adapter type from the server API.
 *
 * Fetches `/api/adapters/:type/ui-parser.js`, evaluates the module source
 * in a scoped context, and extracts the `parseStdoutLine` export.
 *
 * @returns A StdoutLineParser function, or null if unavailable.
 */
export async function loadDynamicParser(adapterType: string): Promise<StdoutLineParser | null> {
  // Return cached parser if already loaded
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;

  // Don't retry types that previously 404'd
  if (failedLoads.has(adapterType)) return null;

  try {
    const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
    if (!response.ok) {
      failedLoads.add(adapterType);
      return null;
    }

    const source = await response.text();

    // Evaluate the module source using URL.createObjectURL + dynamic import().
    // This properly supports ESM modules with `export` statements.
    // (new Function("exports", source) would fail with SyntaxError on `export` keywords.)
    const blob = new Blob([source], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    let parseFn: StdoutLineParser;

    try {
      const mod = await import(/* @vite-ignore */ blobUrl);

      // Prefer the factory function (stateful parser) if available,
      // fall back to the static parseStdoutLine function.
      if (typeof mod.createStdoutParser === "function") {
        // Stateful parser — create one instance for the UI session.
        // Each run creates its own transcript builder, so a single
        // parser instance is sufficient per adapter type.
        const parser = (mod.createStdoutParser as () => { parseLine: StdoutLineParser; reset: () => void })();
        parseFn = parser.parseLine.bind(parser);
      } else if (typeof mod.parseStdoutLine === "function") {
        parseFn = mod.parseStdoutLine as StdoutLineParser;
      } else {
        console.warn(`[adapter-ui-loader] Module for "${adapterType}" exports neither parseStdoutLine nor createStdoutParser`);
        failedLoads.add(adapterType);
        return null;
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    // Cache for reuse
    dynamicParserCache.set(adapterType, parseFn);
    console.info(`[adapter-ui-loader] Loaded dynamic UI parser for "${adapterType}"`);
    return parseFn;
  } catch (err) {
    console.warn(`[adapter-ui-loader] Failed to load UI parser for "${adapterType}":`, err);
    failedLoads.add(adapterType);
    return null;
  }
}

/**
 * Invalidate a cached dynamic parser, removing it from both the parser cache
 * and the failed-loads set so that the next load attempt will try again.
 */
export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated dynamic UI parser for "${adapterType}"`);
  }
  return wasCached;
}
