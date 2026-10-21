import type { SelfProfileSnapshot, SelfProfileProposal } from './self-profile-store.js';
import type { MessageImage } from './image-context.js';
import type { ProfileSubjectCandidate, ProfileSubjectEvidence } from './profile-attribution.js';
export type { SelfProfileSnapshot, SelfProfileProposal } from './self-profile-store.js';

export type AutoMemoryReason = 'count' | 'capacity' | 'idle' | 'interval' | 'backfill';
export type AutoMemoryPipeline = 'legacy' | 'compression' | 'materials';
export interface MaterialBackfillLimits { maxMessages: number; maxBytes: number; maxPending: number }
export interface MaterialBackfillBatch {
  ordinal: number; messageCount: number; humanCount: number; assistantCount: number;
  pendingCount: number; bytes: number; oversized: boolean;
}
export interface MaterialBackfillPlan {
  conversationId: string; cutoffContextSeq: number; planHash: string; limits: MaterialBackfillLimits;
  messageCount: number; humanCount: number; assistantCount: number; pendingCount: number;
  personPendingCount: number; selfPendingCount: number; bytes: number; batchCount: number; oversizedMessages: number;
  excluded: { legacyDoneMessages: number; materialMessages: number; materialPending: number };
  batches: MaterialBackfillBatch[];
}
export interface MaterialBackfillRun extends MaterialBackfillPlan {
  runId: string; reason: string; createdAt: string; jobIds: string[];
  jobs: (MaterialBackfillBatch & { id: string; status: AutoMemoryJob['status']; attempts: number; error?: string;
    deferred?: boolean; retired?: boolean; isolated?: boolean })[];
  status: { queued: number; running: number; failed: number; completed: number; deferred: number; retired: number; isolated: number };
  remainingMessages: number; remainingPending: number; retainedPending: number;
}
export type EvidenceType = 'self' | 'third_party' | 'inference';
export interface ProfileFact {
  content: string;
  sourceType: EvidenceType;
  messageIds: string[];
  field?: string;
  occurredAt?: string | null;
  expiresAt?: string | null;
}
export interface PersonProfilePending { id: string; content: string; sourceMessageId: string; sourceType: EvidenceType; subject?: ProfileSubjectEvidence }
export interface ProfileFactUpdate { factIndex: number; baselineFactIndexes?: number[]; evidence: ProfileSubjectEvidence[] }
export type ProfilePendingResult =
  | { pendingId: string; status: 'merged'; factIndex: number }
  | { pendingId: string; status: 'superseded'; replacementMessageId: string }
  | { pendingId: string; status: 'not_profile'; reason: 'temporary' | 'not_personal' | 'insufficient_evidence' }
  | { pendingId: string; status: 'deferred' };
export interface PersonProfile {
  personId: string; baseVersion: number; facts: ProfileFact[];
  pending?: PersonProfilePending[];
  pendingIds?: string[];
  pendingResults?: ProfilePendingResult[];
  updates?: ProfileFactUpdate[];
}
export interface AutoMemoryMessage {
  images?: MessageImage[];
  imageFailure?: string;
  id: string; conversationId: string; actorId?: string; personId?: string;
  contextSeq?: number; senderId?: string; senderName?: string; replyToSenderId?: string; replyToMessageId?: string;
  role: 'user' | 'assistant'; text: string; ingestSeq: number; createdAt: string; sentAt?: string;
  mentionedSenderIds?: string[];
  runStatus?: string; deliveryStatus?: string; turnInputSeq?: number;
}
export interface AutoMemoryJob {
  pipeline?: AutoMemoryPipeline;
  id: string; conversationId: string; reason: AutoMemoryReason; status: 'queued' | 'running' | 'failed' | 'done';
  startSeq: number; endSeq: number; messageIds: string[]; attempts: number;
  leaseToken?: string; leaseOwner?: string; leaseUntil?: number; error?: string;
}
export interface AutoMemoryTaskInput {
  /** Absent on preserved combined jobs. New tasks write only their own pipeline's results. */
  pipeline?: Exclude<AutoMemoryPipeline, 'legacy'>;
  /** Absent on preserved frozen inputs; version 2 uses program-owned coverage. */
  extractionProtocol?: 2;
  contextProtocol?: 1;
  profileProtocol?: 2;
  /** New material tasks use archived profiles as the model's baseline; old evidence stays audit-only. */
  profileBaselineProtocol?: 1;
  profileAttributionProtocol?: 1;
  selfProfileProtocol?: 2;
  profileSubjects?: ProfileSubjectCandidate[];
  mode?: 'messages' | 'profiles' | 'self';
  job: AutoMemoryJob; roomType: 'private' | 'group'; messages: AutoMemoryMessage[];
  previousSummary?: string; profiles: PersonProfile[]; selfProfile?: SelfProfileSnapshot;
  deferredRanges?: { startSeq: number; endSeq: number }[];
  selfProfileBudgetBytes?: number;
  outputBudget?: { summaryCharacters: number; topicCount: number; topicCharacters: number; topicTotalCharacters: number };
  profileSources?: AutoMemoryMessage[];
  excludedProfileSourceIds?: string[];
  profileFragments?: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[] }[];
  roomRules?: readonly { key: string; content: string }[];
}
export interface MemorySourceRange { startOrdinal: number; endOrdinal: number }
export interface ValidatedExtract {
  ignoredMessageIds: string[];
  topics: { summary: string; messageIds: string[]; sourceRange?: MemorySourceRange }[];
  fragments: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[]; topicIndex?: number }[];
  profiles: PersonProfile[];
  continuationSummary?: string;
  selfProfile?: SelfProfileProposal;
  /** Worker-authored ranges of completed message steps, never model output. */
  processedRanges?: MemorySourceRange[];
}
export interface TopicRecord {
  id: string; conversationId: string; jobId: string; summary: string; version: number; contentHash: string; messageIds: string[];
  facts?: { personId: string; content: string; sourceType: EvidenceType; messageIds: string[] }[];
  sourceRange?: MemorySourceRange;
}
