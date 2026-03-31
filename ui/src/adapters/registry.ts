import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";
import { loadDynamicParser } from "./dynamic-loader";

const uiAdapters: UIAdapterModule[] = [];
const adaptersByType = new Map<string, UIAdapterModule>();

function registerBuiltInUIAdapters() {
  for (const adapter of [
    claudeLocalUIAdapter,
    codexLocalUIAdapter,
    geminiLocalUIAdapter,
    openCodeLocalUIAdapter,
    piLocalUIAdapter,
    cursorLocalUIAdapter,
    openClawGatewayUIAdapter,
    processUIAdapter,
    httpUIAdapter,
  ]) {
    registerUIAdapter(adapter);
  }
}

export function registerUIAdapter(adapter: UIAdapterModule): void {
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === adapter.type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1, adapter);
  } else {
    uiAdapters.push(adapter);
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterUIAdapter(type: string): void {
  if (type === processUIAdapter.type || type === httpUIAdapter.type) return;
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1);
  }
  adaptersByType.delete(type);
}

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

registerBuiltInUIAdapters();

export function getUIAdapter(type: string): UIAdapterModule {
  const builtIn = adaptersByType.get(type);

  if (!builtIn) {
    // No built-in adapter — fall through to the external-only path.
    let loadStarted = false;
    return {
      type,
      label: type,
      parseStdoutLine: (line: string, ts: string) => {
        if (!loadStarted) {
          loadStarted = true;
          loadDynamicParser(type).then((parser) => {
            if (parser) {
              registerUIAdapter({
                type,
                label: type,
                parseStdoutLine: parser,
                ConfigFields: processUIAdapter.ConfigFields,
                buildAdapterConfig: processUIAdapter.buildAdapterConfig,
              });
            }
          });
        }
        return processUIAdapter.parseStdoutLine(line, ts);
      },
      ConfigFields: processUIAdapter.ConfigFields,
      buildAdapterConfig: processUIAdapter.buildAdapterConfig,
    };
  }

  return builtIn;
}

/**
 * Ensure external adapter types (from the server's /api/adapters response)
 * are registered in the UI adapter list so they appear in dropdowns.
 *
 * For each type not already registered, creates a placeholder module that
 * uses the process adapter defaults and kicks off dynamic parser loading.
 * Once the parser resolves, the placeholder is replaced with the real one.
 */
export function syncExternalAdapters(
  serverAdapters: { type: string; label: string }[],
): void {
  for (const { type, label } of serverAdapters) {
    if (adaptersByType.has(type)) continue;

    let loadStarted = false;
    registerUIAdapter({
      type,
      label,
      parseStdoutLine: (line: string, ts: string) => {
        if (!loadStarted) {
          loadStarted = true;
          loadDynamicParser(type).then((parser) => {
            if (parser) {
              registerUIAdapter({
                type,
                label,
                parseStdoutLine: parser,
                ConfigFields: processUIAdapter.ConfigFields,
                buildAdapterConfig: processUIAdapter.buildAdapterConfig,
              });
            }
          });
        }
        return processUIAdapter.parseStdoutLine(line, ts);
      },
      ConfigFields: processUIAdapter.ConfigFields,
      buildAdapterConfig: processUIAdapter.buildAdapterConfig,
    });
  }
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
