import { EventEmitter } from "node:events";

export interface ApprovalsEventMap {
  approved: {
    approvalId: string;
    companyId: string;
    approvalKind: string;
    decidedByUserId: string | null;
    decidedAt: Date;
  };
}

class ApprovalsEvents extends EventEmitter {
  override emit<K extends keyof ApprovalsEventMap>(event: K, payload: ApprovalsEventMap[K]): boolean {
    return super.emit(event, payload);
  }
  override on<K extends keyof ApprovalsEventMap>(event: K, listener: (p: ApprovalsEventMap[K]) => void): this {
    return super.on(event, listener);
  }
}

export const approvalsEvents = new ApprovalsEvents();
