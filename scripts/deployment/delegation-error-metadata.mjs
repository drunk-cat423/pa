import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,100}$/.test(value) ? value : undefined;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const stages = new Set(['prepare', 'answer', 'collect', 'write', 'commit', 'request', 'response']);
const httpStatuses = new Set([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]);
const providerCodes = new Set(['ServiceUnavailable', 'RateLimitExceeded', 'Throttling', 'InvalidParameter', 'InvalidRequestError',
  'AuthenticationError', 'PermissionDenied', 'InternalError', 'RequestTimeout', 'context_length_exceeded']);

/** Project known error fields only. A provider's free-form message may contain prompts or credentials. */
export function errorMetadata(raw) {
  if (typeof raw !== 'string') return {};
  const text = raw.slice(0, 16000);
  const status = Number(/(?:^|\b)([45]\d{2}):\s*\{/.exec(text)?.[1]);
  let body;
  try { const start = text.indexOf('{'); if (start >= 0) body = JSON.parse(text.slice(start)); } catch {}
  const code = body?.code ?? body?.error?.code ?? body?.type;
  const vit = /ViT queue is full:\s*admitted=(\d+),\s*capacity=(\d+),\s*requested=(\d+)/.exec(text);
  const result = { ...(httpStatuses.has(status) ? { httpStatus: status } : {}),
    ...(providerCodes.has(code) ? { providerCode: code } : {}) };
  if (vit) {
    const counts = vit.slice(1).map(Number);
    if (counts.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000)) {
      return { ...result, cause: 'vision_queue_full', admitted: counts[0], capacity: counts[1], requested: counts[2] };
    }
  }
  if (/context[_ ]length[_ ]exceeded|maximum context length/i.test(text)) return { ...result, cause: 'context_limit' };
  if (/rate[_ ]limit|too many requests/i.test(text)) return { ...result, cause: 'rate_limited' };
  if (/timed? out|timeout/i.test(text)) return { ...result, cause: 'timeout_reported' };
  return result;
}

function recordedResponse(dataDir, record) {
  const ref = record.responseRef;
  const expected = `calls/${record.callId}/response.json`;
  if (ref?.path !== expected || !/^[a-f0-9-]{36}$/.test(record.callId) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return;
  const base = resolve(dataDir, 'diagnostics');
  const path = join(base, expected);
  if (realpathSync(path) !== path) throw new Error('Diagnostic response was redirected.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) return;
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return;
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
}

/** Read-only, bounded evidence projection; never opens the application store or performs migrations. */
export function collectModelErrors({ dataDir = '/var/lib/pa', now = Date.now() } = {}) {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  let app, diagnostics;
  const output = [];
  try {
    app = new DatabaseSync(join(dataDir, 'pa.sqlite'), { readOnly: true });
    app.exec('PRAGMA busy_timeout=1000');
    diagnostics = new DatabaseSync(join(dataDir, 'diagnostics/index.sqlite'), { readOnly: true });
    diagnostics.exec('PRAGMA busy_timeout=1000');
    const room = app.prepare('SELECT r.room_type FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE c.id=?');
    const stage = diagnostics.prepare(`SELECT json_extract(event_json,'$.details.stage') AS stage FROM events
      WHERE call_id=? AND json_valid(event_json) AND json_extract(event_json,'$.event')='model.request_prepared' LIMIT 1`);
    const calls = diagnostics.prepare(`SELECT
      json_extract(record_json,'$.callId') AS callId,
      json_extract(record_json,'$.status') AS status,
      json_extract(record_json,'$.createdAt') AS createdAt,
      json_extract(record_json,'$.conversationId') AS conversationId,
      json_extract(record_json,'$.provider') AS provider,
      json_extract(record_json,'$.model') AS model,
      json_extract(record_json,'$.phase') AS phase,
      json_extract(record_json,'$.responseRef.path') AS responsePath,
      json_extract(record_json,'$.responseRef.sha256') AS responseHash
      FROM calls WHERE json_valid(record_json)
      AND json_extract(record_json,'$.status') IN ('unknown','failed')
      AND json_extract(record_json,'$.createdAt')>=?
      ORDER BY rowid DESC LIMIT 30`).all(cutoff);
    for (const r of calls) {
      r.responseRef = { path: r.responsePath, sha256: r.responseHash };
      const time = timestamp(r.createdAt);
      if (!time || !/^[a-f0-9-]{36}$/.test(r.callId)) continue;
      const roomType = room.get(r.conversationId)?.room_type;
      const foundStage = stage.get(r.callId)?.stage;
      let response;
      try { response = recordedResponse(dataDir, r); } catch {}
      const metadata = errorMetadata(response?.errorMessage);
      output.push({ type: 'model_call', callId: r.callId, time, provider: identifier(r.provider), model: identifier(r.model),
        stage: stages.has(foundStage) ? foundStage : stages.has(r.phase) ? r.phase : 'unknown',
        roomType: ['group', 'private'].includes(roomType) ? roomType : 'unknown',
        recordedStatus: r.status, evidence: response?.stopReason === 'error' ? 'provider_error_response'
          : r.status === 'unknown' ? 'outcome_unknown' : 'call_failed',
        ...metadata });
    }
    // Runtime failures also cover errors before a model call was captured.
    for (const row of app.prepare(`SELECT ar.started_at,ar.error_kind,ar.error_message,r.room_type
      FROM agent_runs ar JOIN conversations c ON c.id=ar.conversation_id JOIN rooms r ON r.id=c.room_id
      WHERE ar.status='failed' AND ar.started_at>=? ORDER BY ar.started_at DESC LIMIT 20`).all(cutoff)) {
      output.push({ type: 'agent_run', time: timestamp(row.started_at), stage: 'runtime',
        roomType: ['group', 'private'].includes(row.room_type) ? row.room_type : 'unknown',
        errorKind: ['error', 'timeout', 'cancelled'].includes(row.error_kind) ? row.error_kind : 'unclassified',
        evidence: 'runtime_failure_record', ...errorMetadata(row.error_message) });
    }
    return { type: 'model_error_snapshot', cutoff, complete: true, records: output };
  } catch {
    return { type: 'model_error_snapshot', cutoff, complete: false, records: output, reason: 'diagnostic_metadata_unavailable' };
  } finally { diagnostics?.close(); app?.close(); }
}
