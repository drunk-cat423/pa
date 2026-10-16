import type { PersonProfile } from './auto-memory-types.js';

export const PERSON_PROFILE_LIMITS = Object.freeze({
  maxFacts: 40,
  maxFactChars: 200,
  maxContentBytes: 6000,
  maxStructureBytes: 16000,
  maxSourcesPerFact: 5,
  softRatio: 0.75,
});

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
    if (Array.from(fact.content).length > PERSON_PROFILE_LIMITS.maxFactChars ||
        fact.messageIds.length > PERSON_PROFILE_LIMITS.maxSourcesPerFact) {
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
