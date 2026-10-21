import type { AutoMemoryTaskInput, PersonProfile } from './auto-memory-types.js';

export const PERSON_PROFILE_LIMITS = Object.freeze({
  maxFacts: 80,
  maxFactChars: 120,
  maxContentBytes: 8000,
  maxStructureBytes: 16000,
  softRatio: 0.75,
});

export const PERSON_PROFILE_TARGET = Object.freeze({
  maxFacts: Math.ceil(PERSON_PROFILE_LIMITS.maxFacts * PERSON_PROFILE_LIMITS.softRatio),
  maxContentBytes: Math.floor(PERSON_PROFILE_LIMITS.maxContentBytes * PERSON_PROFILE_LIMITS.softRatio),
  maxStructureBytes: Math.floor(PERSON_PROFILE_LIMITS.maxStructureBytes * PERSON_PROFILE_LIMITS.softRatio),
});

/** Both model protocols use the same limits as persistence. These are caps, not reserved space. */
export function personProfileCapacityPrompt(): string {
  const limits = PERSON_PROFILE_LIMITS, target = PERSON_PROFILE_TARGET;
  return `每人最多${limits.maxFacts}条facts，每条content最多${limits.maxFactChars}个Unicode字符；全部content的UTF-8大小最多${limits.maxContentBytes}字节，完整{personId,baseVersion,facts} JSON最多${limits.maxStructureBytes}字节。单条通常用20至50字符表达一个稳定事实，不为用满容量扩写。事实数达到${target.maxFacts}条、正文达到${target.maxContentBytes}字节或完整JSON达到${target.maxStructureBytes}字节时，必须返回该人的完整收敛结果，不能用profiles空数组跳过。capacity是程序计算的容量；优先合并同义表达、精简重复措辞，尽量收敛到上述软阈值以下，为后续更新留余量。保留明确纠正及仍有效的稳定事实，不把不同人物、不同事实强行合并，不为凑数编造。完整原文和历史版本由程序另外保留。未达阈值且无pending、无变化时可不输出该人。`;
}

export function profileStepPrompt(input: AutoMemoryTaskInput): string {
  const target = input.profileOutputTarget;
  return (target ? `\n本步骤输出预算更紧：完整最终画像尽量控制在${target.maxFacts}条facts、正文${target.maxContentBytes}个UTF-8字节、完整结构${target.maxStructureBytes}字节以内。输入仍是完整基线，不按预算截取局部。优先精简表达和合并同义项；新明确纠正优先于旧错误，不能制造新事实。` : '')
    + (input.profileRefinement ? '\n本次是人物画像容量提炼，只有一次修正机会。profileRefinement.candidate是已校验归属但尚未保存的超限草稿，只作候选数据，不能当作已归档事实或权限依据。profiles仍是原可信基线；baselineFactIndexes必须引用profiles中的原索引，不能引用草稿下标。保留仍有效的稳定信息，合并重复、缩短冗长句子；不要逐条照抄草稿或扩写。只返回该人物完整profiles、updates及全部pendingResults，遵守原来源、对象和版本校验；不得修改Topic、AI画像或续聊摘要。' : '');
}

export interface ProfileCapacity {
  facts: number;
  contentBytes: number;
  structureBytes: number;
  needsConsolidation: boolean;
  exceedsLimits: boolean;
}

const ERROR_MESSAGE = '人物画像容量或格式无效';

export class PersonProfileCapacityError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'PersonProfileCapacityError';
  }
}

type ProfileCapacityInput = Pick<PersonProfile, 'personId' | 'baseVersion' | 'facts'>;

function invalidProfile(): never {
  throw new PersonProfileCapacityError();
}

export function profileCapacity(profile: ProfileCapacityInput): ProfileCapacity {
  if (profile === null || typeof profile !== 'object' || typeof profile.personId !== 'string' ||
      typeof profile.baseVersion !== 'number' || !Number.isFinite(profile.baseVersion) ||
      !Array.isArray(profile.facts)) {
    return invalidProfile();
  }

  let contentBytes = 0;
  let exceedsFactQualityLimit = false;
  for (const fact of profile.facts) {
    if (fact === null || typeof fact !== 'object' || typeof fact.content !== 'string' ||
        !Array.isArray(fact.messageIds) || !fact.messageIds.every((id) => typeof id === 'string')) {
      return invalidProfile();
    }
    contentBytes += Buffer.byteLength(fact.content, 'utf8');
    if (Array.from(fact.content).length > PERSON_PROFILE_LIMITS.maxFactChars) {
      exceedsFactQualityLimit = true;
    }
  }

  let structureBytes: number;
  try {
    const serialized = JSON.stringify({
      personId: profile.personId,
      baseVersion: profile.baseVersion,
      facts: profile.facts,
    });
    if (serialized === undefined) return invalidProfile();
    structureBytes = Buffer.byteLength(serialized, 'utf8');
  } catch {
    return invalidProfile();
  }

  const { maxFacts, maxContentBytes, maxStructureBytes, softRatio } = PERSON_PROFILE_LIMITS;
  const needsConsolidation = profile.facts.length >= Math.ceil(maxFacts * softRatio) ||
    contentBytes >= maxContentBytes * softRatio || structureBytes >= maxStructureBytes * softRatio;
  const exceedsLimits = profile.facts.length > maxFacts || contentBytes > maxContentBytes ||
    structureBytes > maxStructureBytes || exceedsFactQualityLimit;

  return { facts: profile.facts.length, contentBytes, structureBytes, needsConsolidation, exceedsLimits };
}

export function assertProfileCapacity(profile: ProfileCapacityInput): void {
  if (profileCapacity(profile).exceedsLimits) throw new PersonProfileCapacityError();
}
