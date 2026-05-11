// In-process EventEmitter for outcomes state transitions.
// Emitted by OutcomesService after successful verify / revert operations.
// Subscribers (memory, analytics, etc.) attach at boot and handle events
// best-effort — failures in subscribers must not propagate back.

import { EventEmitter } from "node:events";

export interface OutcomesEventMap {
  verified: {
    kind: string;
    targetKind: string;
    targetId: string;
    companyId: string;
    verifiedMeta?: unknown;
  };
  reverted: {
    outcomeId: string;
    kind: string;
    targetKind: string;
    targetId: string;
    companyId: string;
    reason: string;
    parentReopened: boolean;
  };
}

class OutcomesEvents extends EventEmitter {
  emit<K extends keyof OutcomesEventMap>(event: K, data: OutcomesEventMap[K]): boolean {
    return super.emit(event, data);
  }
  on<K extends keyof OutcomesEventMap>(event: K, listener: (data: OutcomesEventMap[K]) => void): this {
    return super.on(event, listener);
  }
}

export const outcomesEvents = new OutcomesEvents();
