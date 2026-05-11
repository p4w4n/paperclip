// Plugin contract for the OrgLearningService.

export type PlaybookStatus = "proposed" | "active" | "archived" | "superseded";

export interface ApplicabilityConditions {
  issue_keywords?: string[];
  labels?: string[];
  project_id?: string;
  agent_role?: string;
  min_confidence?: number;
}

export interface IssueContext {
  title: string;
  body?: string;
  labels: string[];
  projectId?: string;
  assigneeAgentId?: string;
  titleEmbedding?: Float32Array;
}

export interface Playbook {
  id: string;
  companyId: string;
  agentId: string | null;
  title: string;
  slug: string;
  status: PlaybookStatus;
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  applicabilityConditions: ApplicabilityConditions | null;
  sourceRunIds: string[] | null;
  sourcePlanIds: string[] | null;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  archivedAt: Date | null;
}

export interface PlaybookRevision {
  id: string;
  playbookId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contentMarkdown: string;
  changeSummary: string | null;
  createdAt: Date;
}

export interface OutcomePattern {
  id: string;
  companyId: string;
  patternName: string;
  patternDescription: string | null;
  exemplarRunIds: string[];
  clusterSize: number;
  derivedAt: Date;
  confidence: number;
  promotedToPlaybookId: string | null;
  archivedAt: Date | null;
}

export interface AgentSkill {
  agentId: string;
  companyId: string;
  skillName: string;
  evidenceRunIds: string[];
  lastEvidencedAt: Date;
  confidence: number;
  derivedAt: Date;
}

export interface DecisionPattern {
  id: string;
  companyId: string;
  conditionSummary: string;
  typicalChoice: string;
  exemplarDecisionIds: string[];
  clusterSize: number;
  derivedAt: Date;
  confidence: number;
  supersededAt: Date | null;
  supersededById: string | null;
}

export interface CreatePlaybookInput {
  companyId: string;
  agentId?: string;
  title: string;
  slug: string;
  contentMarkdown: string;
  applicabilityConditions?: ApplicabilityConditions;
  sourceRunIds?: string[];
  sourcePlanIds?: string[];
  confidence?: number;
  status?: PlaybookStatus;
  createdByAgentId?: string;
}

export interface RevisePlaybookInput {
  contentMarkdown: string;
  changeSummary: string;
  applicabilityConditions?: ApplicabilityConditions;
  createdByAgentId?: string;
}

export interface SuggestionResult {
  playbook: Playbook;
  score: number;
  reason: string;
  /** Number of entries in playbook.suggestedOutcomes. UI uses this to decide whether to show [Apply]. */
  suggestedOutcomesCount: number;
}

export interface OrgLearningServiceContext {
  callerCompanyId: string;
}

export interface OrgLearningService {
  createPlaybook(
    ctx: OrgLearningServiceContext,
    input: CreatePlaybookInput,
  ): Promise<Playbook>;
  revisePlaybook(
    ctx: OrgLearningServiceContext,
    id: string,
    input: RevisePlaybookInput,
  ): Promise<PlaybookRevision>;
  approvePlaybook(ctx: OrgLearningServiceContext, id: string): Promise<void>;
  archivePlaybook(ctx: OrgLearningServiceContext, id: string): Promise<void>;
  listPlaybooks(
    ctx: OrgLearningServiceContext,
    filter: { companyId: string; status?: PlaybookStatus; agentId?: string | null; limit?: number },
  ): Promise<Playbook[]>;
  getPlaybook(
    ctx: OrgLearningServiceContext,
    id: string,
  ): Promise<{ playbook: Playbook; currentRevision: PlaybookRevision | null } | null>;
  listOutcomePatterns(
    ctx: OrgLearningServiceContext,
    filter: { companyId: string; limit?: number },
  ): Promise<OutcomePattern[]>;
  promotePatternToPlaybook(
    ctx: OrgLearningServiceContext,
    patternId: string,
    input: { contentMarkdown: string; title?: string; slug?: string },
  ): Promise<Playbook>;
  listAgentSkills(
    ctx: OrgLearningServiceContext,
    filter: { agentId: string; companyId: string },
  ): Promise<AgentSkill[]>;
  listDecisionPatterns(
    ctx: OrgLearningServiceContext,
    filter: { companyId: string; limit?: number },
  ): Promise<DecisionPattern[]>;
  suggestPlaybooks(
    ctx: OrgLearningServiceContext,
    input: { companyId: string; issueContext: IssueContext; limit?: number; threshold?: number },
  ): Promise<SuggestionResult[]>;
  getSuggestedOutcomesForPlaybook(
    ctx: OrgLearningServiceContext,
    playbookId: string,
  ): Promise<unknown[] | null>;
}

export class LearningTenantMismatchError extends Error {
  constructor(callerCompanyId: string, inputCompanyId: string) {
    super(
      `learning tenant mismatch: caller company ${callerCompanyId} does not match input ${inputCompanyId}`,
    );
    this.name = "LearningTenantMismatchError";
  }
}
