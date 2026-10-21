import type { AutoMemoryTaskInput, MemorySourceRange } from './auto-memory-types.js';
import type { PaConfig } from './config.js';

export const COMPACT_TOPIC_LIMITS = { count: 8, characters: 400, totalCharacters: 2000 } as const;

export class MemoryOutputBudgetError extends Error {
  constructor() {
    super('整理结果的预计篇幅超出输出预算，尚未提交模型。');
    this.name = 'MemoryOutputBudgetError';
  }
}

export function memoryOutputBudget(config: PaConfig, pipeline?: AutoMemoryTaskInput['pipeline']): NonNullable<AutoMemoryTaskInput['outputBudget']> {
  const tokens = Math.min(config.memory?.maxOutputTokens ?? config.maxOutputTokens ?? 8192, Math.floor(config.contextWindow / 4));
  const summaryCharacters = pipeline === 'materials' ? 0 : Math.max(16, Math.min(2000, Math.floor(tokens * 0.23)));
  const topicTotalCharacters = pipeline === 'compression' ? 0 : Math.max(0, Math.min(COMPACT_TOPIC_LIMITS.totalCharacters, Math.floor(tokens * 0.16)));
  return { summaryCharacters, topicCount: Math.min(COMPACT_TOPIC_LIMITS.count, Math.floor(topicTotalCharacters / 120)),
    topicCharacters: Math.min(COMPACT_TOPIC_LIMITS.characters, topicTotalCharacters), topicTotalCharacters };
}

/** This is an output-risk estimate, not measured usage and never a claim about billing. */
export function assertMemoryOutputFits(input: AutoMemoryTaskInput, config: PaConfig): void {
  if (input.extractionProtocol !== 2 || input.mode === 'messages') return;
  const tokens = Math.min(config.memory?.maxOutputTokens ?? config.maxOutputTokens ?? 8192, Math.floor(config.contextWindow / 4));
  let estimate = 96;
  const selfEstimate = input.selfProfile ? Math.min(2000, [...input.selfProfile.content].length) * 2
    + (input.selfProfile.sourceMessageIds?.length ?? 0) * 8 + input.selfProfile.pending.length * 48 : 0;
  if (input.mode === undefined && input.outputBudget) {
    estimate += (input.outputBudget.summaryCharacters + input.outputBudget.topicTotalCharacters) * 2
      + input.outputBudget.topicCount * 32;
  }
  if (input.mode === 'self' && input.selfProfile) {
    estimate += selfEstimate;
  } else {
    for (const profile of input.profiles) {
      // Plan for the bounded convergence target, not an unbounded legacy input.
      // Large existing profiles must still be able to become smaller.
      const contentBytes = Math.min(4500, profile.facts.reduce((sum, fact) => sum + Buffer.byteLength(fact.content), 0));
      const factCount = Math.min(30, profile.facts.length);
      const sources = Math.min(150, profile.facts.reduce((sum, fact) => sum + fact.messageIds.length, 0));
      estimate += 128 + contentBytes * 0.75 + factCount * 64 + sources * 8 + (profile.pending?.length ?? 0) * 64;
    }
    estimate += selfEstimate;
  }
  if (estimate > tokens * 0.9) throw new MemoryOutputBudgetError();
}

/** Ordinals refer to the immutable parent snapshot, including gaps excluded when it was captured. */
export function memorySourceRange(input: AutoMemoryTaskInput): MemorySourceRange {
  const positions = new Map(input.job.messageIds.map((id, index) => [id, index]));
  const ordinals = input.messages.map(message => positions.get(message.id));
  const first = ordinals[0], last = ordinals.at(-1);
  if (first === undefined || last === undefined || ordinals.some((ordinal, index) => ordinal !== first + index)) {
    throw new Error('后台消息步骤必须对应固定快照中的连续区间。');
  }
  return { startOrdinal: first, endOrdinal: last };
}

export function assertMemorySourceRange(range: MemorySourceRange, length: number): void {
  if (!range || !Number.isSafeInteger(range.startOrdinal) || !Number.isSafeInteger(range.endOrdinal)
    || range.startOrdinal < 0 || range.endOrdinal < range.startOrdinal || range.endOrdinal >= length) {
    throw new Error('整理步骤的来源范围无效。');
  }
}

/** Program completion receipts cover execution ranges; they do not prove semantic completeness. */
export function assertProcessedRanges(ranges: MemorySourceRange[] | undefined, length: number): void {
  if (length === 0 && Array.isArray(ranges) && ranges.length === 0) return;
  if (!Array.isArray(ranges) || !ranges.length) throw new Error('缺少整理步骤的完成回执。');
  const sorted = [...ranges].sort((a, b) => a.startOrdinal - b.startOrdinal);
  let next = 0;
  for (const range of sorted) {
    assertMemorySourceRange(range, length);
    if (range.startOrdinal !== next) throw new Error('整理步骤的完成范围有缺口或重叠。');
    next = range.endOrdinal + 1;
  }
  if (next !== length) throw new Error('整理步骤尚未处理完整固定快照。');
}
