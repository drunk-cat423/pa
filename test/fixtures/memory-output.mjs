import { DatabaseSync } from 'node:sqlite';

export function emptyExtraction(input, summary = '继续对话') {
  const compact = input.extractionProtocol === 2;
  const result = { topics: [], fragments: [], profiles: [], ignoredMessageIds: compact ? [] : input.messages.filter(m => m.role === 'user').map(m => m.id) };
  if(input.materialsProtocol===3 && input.mode==='profiles') result.profiles=input.profiles.map(profile=>({
    personId:profile.personId,baseVersion:profile.baseVersion,facts:profile.facts,updates:[],
    pendingResults:(profile.pending??[]).map(item=>({pendingId:item.id,status:'deferred'})),
  }));
  if (input.mode !== 'profiles' && input.mode !== 'self') {
    if (input.pipeline !== 'materials' && (input.roomType === 'private' || input.contextProtocol === 1)) result.continuationSummary = summary;
    if (compact && input.messages.length) {
      const first = input.job.messageIds.indexOf(input.messages[0].id);
      result.processedRanges = [{ startOrdinal: first, endOrdinal: first + input.messages.length - 1 }];
    }
    else if (compact) result.processedRanges = [];
  }
  return result;
}

/** Build an actual old frozen snapshot in a temporary test database, never in production. */
export function legacyFrozenInput(store, path, job) {
  const input = store.autoMemory.taskInput(job);
  delete input.extractionProtocol;
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(input), job.id); }
  finally { db.close(); }
  return store.autoMemory.taskInput(job);
}
