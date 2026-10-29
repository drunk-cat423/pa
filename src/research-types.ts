import type { ChannelRoute } from './channel-types.js';

export type ResearchStatus = 'queued' | 'running' | 'completed' | 'partial' | 'blocked' | 'failed' | 'interrupted';
export interface ResearchBudget { maxModelCalls: number; maxToolCalls: number; maxSearchCalls: number }
export interface ResearchUsage { modelCalls: number; toolCalls: number; searchCalls: number }
export interface ResearchEvidence { tool: string; input: unknown; result?: unknown; error?: string }
export interface ResearchProgress extends ResearchUsage { evidence?: ResearchEvidence; error?: string }
export interface CreateResearchInput {
  key: string; title: string; goal: string; urls?: string[]; requiresOriginal?: boolean;
}
export interface ContinueResearchInput { id: string; key: string; requirements?: string }
export interface ResearchTask {
  id: string; conversationId: string; sourceMessageId: string; actorId: string; personId: string;
  route: ChannelRoute; senderId: string; originalText: string;
  title: string; goal: string; urls: string[]; requiresOriginal: boolean;
  status: ResearchStatus; attempt: number; createdAt: string; updatedAt: string;
  reportVersion?: number; reason?: string;
  budget?: ResearchBudget; usage: ResearchUsage; evidence: ResearchEvidence[];
  /** Authorized follow-ups are task instructions, separate from fetched evidence. */
  followups: { attempt: number; requirements: string; sourceMessageId: string }[];
}
/** Queue and notification state never needs to expand saved research materials. */
export type ResearchTaskMetadata = Omit<ResearchTask, 'evidence' | 'followups'>;
export interface ResearchListParams { date?: string; query?: string; limit?: number; offset?: number }
export interface ResearchList {
  total: number; offset: number; nextOffset?: number;
  items: { id: string; title: string; status: ResearchStatus; createdAt: string; reportVersion?: number; abstract?: string; reason?: string }[];
}
export interface ResearchReadParams { id: string; version?: number; offset?: number; limit?: number; draft?: boolean }
export interface ResearchReport {
  id: string; version: number; title: string; abstract: string; keywords: string[]; createdAt: string;
  status: 'completed' | 'partial'; markdown: string;
}
export interface ResearchReadResult {
  draft?: boolean;
  id: string; version?: number; title: string; status: ResearchStatus; abstract?: string; createdAt: string;
  text: string; offset: number; totalChars: number; nextOffset?: number; reason?: string;
}
export interface ResearchFinishInput {
  status: Exclude<ResearchStatus, 'queued' | 'running'>;
  markdown?: string; abstract?: string; keywords?: string[]; reason?: string;
}
export type ResearchDeliveryStatus = 'sending' | 'sent' | 'uncertain' | 'rejected';
export interface ResearchDelivery {
  deliveryId: string; status: ResearchDeliveryStatus; shouldSend: boolean;
  route: ChannelRoute;
  reportId: string; version: number; file?: { name: string; data: Buffer }; text?: string;
}
