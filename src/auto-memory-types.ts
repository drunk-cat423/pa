import type { SelfProfileSnapshot, SelfProfileProposal } from './self-profile-store.js';
export type { SelfProfileSnapshot, SelfProfileProposal } from './self-profile-store.js';

export type AutoMemoryReason = 'count' | 'capacity';
export type EvidenceType = 'self' | 'third_party' | 'inference';
export interface ProfileFact {
  content: string;
  sourceType: EvidenceType;
  messageIds: string[];
  field?: string;
  occurredAt?: string | null;
  expiresAt?: string | null;
}
export interface PersonProfilePending { id: string; content: string; sourceMessageId: string; sourceType: EvidenceType }
export interface PersonProfile {
  personId: string; baseVersion: number; facts: ProfileFact[];
  pending?: PersonProfilePending[];
  pendingIds?: string[];
}
export interface AutoMemoryMessage {
  id: string; conversationId: string; actorId?: string; personId?: string;
  role: 'user' | 'assistant'; text: string; ingestSeq: number; createdAt: string; sentAt?: string;
  runStatus?: string; deliveryStatus?: string; turnInputSeq?: number;
}
export interface AutoMemoryJob {
  id: string; conversationId: string; reason: AutoMemoryReason; status: 'queued' | 'running' | 'failed' | 'done';
  startSeq: number; endSeq: number; messageIds: string[]; attempts: number;
  leaseToken?: string; leaseOwner?: string; leaseUntil?: number; error?: string;
}
export interface AutoMemoryTaskInput {
  job: AutoMemoryJob; roomType: 'private' | 'group'; messages: AutoMemoryMessage[];
  previousSummary?: string; profiles: PersonProfile[]; selfProfile?: SelfProfileSnapshot;
  deferredRanges?: { startSeq: number; endSeq: number }[];
  selfProfileBudgetBytes?: number;
  profileSources?: AutoMemoryMessage[];
  excludedProfileSourceIds?: string[];
  profileFragments?: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[] }[];
  roomRules?: readonly { key: string; content: string }[];
}
export interface ValidatedExtract {
  ignoredMessageIds: string[];
  topics: { summary: string; messageIds: string[] }[];
  fragments: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[]; topicIndex?: number }[];
  profiles: PersonProfile[];
  continuationSummary?: string;
  selfProfile?: SelfProfileProposal;
}
export interface TopicRecord {
  id: string; conversationId: string; jobId: string; summary: string; version: number; contentHash: string; messageIds: string[];
  facts?: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[] }[];
}
