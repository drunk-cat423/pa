export type ResearchPhase = 'plan' | 'write' | 'review';
export interface ResearchPlanSection { id: string; title: string; objective: string; acceptance: string }
export interface ResearchPlan { version: 1; sections: ResearchPlanSection[] }
export type ResearchSectionStatus = 'pending' | 'draft' | 'written' | 'approved' | 'needs_revision' | 'blocked';
export interface ResearchSection extends ResearchPlanSection {
  version: number; status: ResearchSectionStatus; markdown: string; summary: string; sources: string[]; gaps: string[];
  reviewReason?: string;
}
export interface ResearchWorkflow { plan?: ResearchPlan; sections: ResearchSection[]; nextCycle: number }
export interface ResearchCycleInput {
  phase: ResearchPhase; sectionId?: string; expectedVersion?: number; input: unknown;
}
export interface ResearchSectionInput {
  sectionId: string; expectedVersion: number; mode: 'append' | 'replace';
  status: 'draft' | 'written' | 'blocked'; markdown: string; summary: string; sources: string[]; gaps: string[];
}
export interface ResearchReviewInput { sectionId: string; expectedVersion: number; verdict: 'pass' | 'revise' | 'blocked'; reason: string }
