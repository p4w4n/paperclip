import { EventEmitter } from "node:events";

export interface PlansEventMap {
  completed: {
    planId: string;
    companyId: string;
    issueId: string | null;   // plans.issue_id
    completedAt: Date;
    revisionId: string | null;
  };
  phaseCompleted: {
    planPhaseId: string;
    companyId: string;
    planId: string;
    planIssueId: string | null;
    exitCriteriaMarkdown: string;
  };
  phaseMarkdownUpdated: {
    planPhaseId: string;
    companyId: string;
    planId: string;
    planIssueId: string | null;
    exitCriteriaMarkdown: string;
  };
  decisionRecorded: {
    decisionId: string;
    companyId: string;
    planId: string;
    planIssueId: string | null;
    title: string;            // plan_decisions.title
    chosenOptionId: string | null;
    decidedAt: Date;
  };
}

class PlansEvents extends EventEmitter {
  override emit<K extends keyof PlansEventMap>(event: K, payload: PlansEventMap[K]): boolean {
    return super.emit(event, payload);
  }
  override on<K extends keyof PlansEventMap>(event: K, listener: (p: PlansEventMap[K]) => void): this {
    return super.on(event, listener);
  }
}

export const plansEvents = new PlansEvents();
