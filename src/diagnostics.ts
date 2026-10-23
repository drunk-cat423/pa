import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizedInputTokens, validContextCalibration, type ContextCalibration } from './context-tokens.js';

export interface DiagnosticContext {
  traceId: string;
  taskId?: string;
  jobId?: string;
  runId?: string;
  conversationId?: string;
  attempt?: number;
}
export interface DiagnosticCallSpec extends DiagnosticContext {
  kind: 'chat' | 'memory' | 'search';
  provider: string;
  model: string;
  phase: string;
  captureLevel?: 'sdk-normalized' | 'http-json';
  contextCalibration?: ContextCalibration;
}
export interface DiagnosticArtifactRef { path: string; sha256: string; bytes: number }
export interface DiagnosticCallRecord extends DiagnosticCallSpec {
  callId: string;
  status: 'started' | 'completed' | 'failed' | 'unknown';
  createdAt: string;
  updatedAt: string;
  /** SDK messages/options, never an assertion that raw HTTP was captured. */
  captureLevel: 'sdk-normalized' | 'http-json';
  requestRef: DiagnosticArtifactRef;
  responseRef?: DiagnosticArtifactRef;
  inputRef?: DiagnosticArtifactRef;
  usage?: unknown;
  usageSource?: 'sdk-normalized' | 'provider-json';
  /** SDK usage/cost is observational; it does not establish provider billing. */
  billedUsage: null;
}
export interface DiagnosticEvent extends DiagnosticContext {
  id: string;
  at: string;
  phase: string;
  event: string;
  details?: Record<string, unknown>;
  callId?: string;
}
export interface DiagnosticFilter { callId?: string; jobId?: string; taskId?: string; traceId?: string; limit?: number }

/** Deliberately excludes the original exception, URLs, payloads and credentials. */
export class DiagnosticPersistenceError extends Error {
  constructor(message = '诊断证据持久化或读取失败；未自动重试。') {
    super(message);
    this.name = 'DiagnosticPersistenceError';
  }
}

export const DIAGNOSTIC_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const VERSION = 1;
const RETENTION_NOTICE = '研究诊断正文已按30天保留规则清理；调用用量/失败阶段/审计仍保留，无法离线重放。';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const names = new Set(['request', 'response', 'input']);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function fail(message: string): never { throw new DiagnosticPersistenceError(message); }

/** Reject links in every existing path component, including the configured data directory. */
function inspectPath(path: string): void {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) fail('诊断路径包含符号链接，已拒绝。');
      if (i < parts.length - 1 && !stat.isDirectory()) fail('诊断父路径不是目录。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function privateDirectory(path: string): void {
  inspectPath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  inspectPath(path);
  if (!lstatSync(path).isDirectory()) fail('诊断路径不是目录。');
  chmodSync(path, 0o700);
}

function safeRead(path: string, maxBytes: number): Buffer {
  inspectPath(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('诊断文件类型或链接数量无效。');
    if (stat.size > maxBytes) fail('诊断证据超过大小上限，未读取残缺内容。');
    const data = readFileSync(fd);
    if (data.length > maxBytes) fail('诊断证据超过大小上限，未读取残缺内容。');
    return data;
  } finally { closeSync(fd); }
}

/** A hard link publishes a fully fsynced file atomically without replacing any prior evidence. */
function immutableWrite(path: string, data: Buffer): void {
  inspectPath(path);
  if (existsSync(path)) {
    if (!safeRead(path, DIAGNOSTIC_MAX_ARTIFACT_BYTES).equals(data)) fail('诊断证据已存在且内容不同，禁止覆盖。');
    return;
  }
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !safeRead(path, DIAGNOSTIC_MAX_ARTIFACT_BYTES).equals(data)) throw error;
    }
  } finally { unlinkSync(temp); }
}

/** Local-only evidence capture. Constructing or querying this object never creates a database. */
export class DiagnosticLog {
  private readonly root: string;
  private readonly databasePath: string;
  private readonly secrets: readonly string[];
  private windowsAclApplied = false;

  constructor(dataDir: string, secrets: readonly string[] = []) {
    this.root = resolve(dataDir, 'diagnostics');
    this.databasePath = join(this.root, 'index.sqlite');
    this.secrets = [...new Set(secrets.filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  }

  private guard<T>(action: () => T): T {
    try { return action(); }
    catch (error) { if (error instanceof DiagnosticPersistenceError) throw error; throw new DiagnosticPersistenceError(); }
  }

  private clean(value: unknown, ancestors = new Set<object>()): unknown {
    if (value instanceof Error) fail('诊断接口不接受原始 Error，请提供固定错误类别。');
    if (typeof value === 'string') {
      let result = value;
      for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
      // Model text and SDK errors can contain JSON inside JSON strings. Decode complete
      // documents before redacting so escaped quotes cannot leak a credential suffix.
      // Preserve original formatting when recursive cleaning did not change any value.
      const documentStart = /^[\s]*[\[{\"]/.test(result) ? 0 : result.search(/[\[{]/);
      if (documentStart >= 0) {
        let parsed: unknown;
        try { parsed = JSON.parse(result.slice(documentStart)); } catch { /* ordinary text falls through */ }
        if (parsed !== undefined) {
          const cleaned = this.clean(parsed, ancestors);
          const encoded = JSON.stringify(cleaned);
          if (encoded !== JSON.stringify(parsed)) result = result.slice(0, documentStart) + encoded;
        }
      }
      return result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
        .replace(/((?:authorization|api[_-]?key|access[_-]?token|lease[_-]?token|password|secret|cookie)["']?\s*[=:]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&}]+)/gi,
          (_match: string, prefix: string, value: string) => {
            const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
            return prefix + quote + '[REDACTED]' + quote;
          });
    }
    if (value === undefined) return null;
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) fail('诊断证据包含循环引用。');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => this.clean(item, ancestors));
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const sensitive = /^(auth|authorization|cookie|setcookie|apikey|secret|secrets|clientsecret|password|credential|credentials|privatekey|signingkey)$/.test(normalized)
          || /(?:apikey|password|secret|credential|privatekey|secretkey|accesskey)(?:id|pem)?$/.test(normalized)
          || (/tokens?$/.test(normalized) && typeof item !== 'number');
        // Usage token counters (inputTokens/outputTokens/cacheReadTokens/etc.) remain evidence.
        const safeKey = this.clean(key) as string;
        if (Object.hasOwn(output, safeKey)) fail('诊断字段脱敏后发生名称冲突，未保存残缺证据。');
        output[safeKey] = sensitive ? '[REDACTED]' : this.clean(item, ancestors);
      }
      return output;
    } finally { ancestors.delete(value); }
  }

  private encode(value: unknown, maxBytes: number): Buffer {
    const json = JSON.stringify(this.clean(value));
    if (json === undefined) fail('诊断证据无法编码为 JSON。');
    const data = Buffer.from(json, 'utf8');
    if (data.length > maxBytes) fail('诊断证据超过大小上限，未裁剪或保存残缺内容。');
    return data;
  }

  private context(input: DiagnosticContext): DiagnosticContext {
    const result: DiagnosticContext = { traceId: input.traceId };
    for (const key of ['traceId', 'taskId', 'jobId', 'runId', 'conversationId'] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || !value.length || value.length > 512) fail('诊断关联标识无效。');
        result[key] = this.clean(value) as string;
      }
    }
    if (!result.traceId) fail('诊断 traceId 不能为空。');
    if (input.attempt !== undefined) {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) fail('诊断调用次数无效。');
      result.attempt = input.attempt;
    }
    return result;
  }

  private withDatabase<T>(write: boolean, action: (database: DatabaseSync) => T, absent: () => T): T {
    inspectPath(this.databasePath);
    if (!write && !existsSync(this.databasePath)) return absent();
    let created = false;
    if (write) {
      privateDirectory(this.root);
      if (process.platform === 'win32' && !this.windowsAclApplied) {
        // chmod(0700) alone does not restrict NTFS ACLs. Only this dedicated root is changed.
        // A new protected ACL grants the current Windows SID inheritable access, with no broad inherited ACEs.
        // Passing an encoded fixed script avoids PowerShell interpretation of user-supplied path text.
        const encodedPath = Buffer.from(this.root, 'utf8').toString('base64');
        const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); `
          + `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if ($null -eq $sid) { throw 'Missing SID' }; `
          + `$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); `
          + `$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,`
          + `[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); `
          + `$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($target,$acl); `
          + `$actual=[IO.Directory]::GetAccessControl($target); if (!$actual.AreAccessRulesProtected) { throw 'ACL is not protected' }; `
          + `foreach ($ace in $actual.Access) { if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected access grant' } }`;
        execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { stdio: 'pipe', windowsHide: true, timeout: 15000 });
        this.windowsAclApplied = true;
      }
      privateDirectory(join(this.root, 'calls'));
      privateDirectory(join(this.root, 'events'));
      try { const fd = openSync(this.databasePath, 'wx', 0o600); closeSync(fd); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    inspectPath(this.databasePath);
    const stat = lstatSync(this.databasePath);
    if (!stat.isFile() || stat.nlink !== 1) fail('诊断索引不是独立常规文件。');
    const database = new DatabaseSync(this.databasePath, { readOnly: !write });
    try {
      database.exec('PRAGMA busy_timeout=5000');
      if (write) database.exec('BEGIN IMMEDIATE');
      try {
        const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
        const empty = version === 0 && write && Number(database.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count) === 0;
        if (version === 0 && write && (created || stat.size === 0 || empty)) {
          database.exec(`CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, job_id TEXT, task_id TEXT, trace_id TEXT NOT NULL, record_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, job_id TEXT, task_id TEXT, trace_id TEXT NOT NULL, event_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS calls_trace ON calls(trace_id);
            CREATE INDEX IF NOT EXISTS calls_task ON calls(task_id);
            CREATE INDEX IF NOT EXISTS calls_job ON calls(job_id);
            CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id);
            CREATE INDEX IF NOT EXISTS events_call ON events(call_id);
            CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
            CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
            PRAGMA user_version=1;`);
        } else if (version !== VERSION) fail('诊断索引版本未知，已拒绝读取或迁移。');
        const result = action(database);
        if (write) database.exec('COMMIT');
        return result;
      } catch (error) { if (write) { try { database.exec('ROLLBACK'); } catch { /* preserve the original classified error */ } } throw error; }
    } finally { database.close(); }
  }

  private getCall(database: DatabaseSync, callId: string): DiagnosticCallRecord {
    if (!UUID.test(callId)) fail('诊断 callId 必须是有效的 UUID v4。');
    const row = database.prepare('SELECT record_json FROM calls WHERE call_id=?').get(callId);
    if (!row) fail('诊断调用不存在。');
    return JSON.parse(String(row.record_json)) as DiagnosticCallRecord;
  }

  /** Read the committed cleanup manifest without creating or migrating the business database. */
  private artifactExpired(callId: string, name: 'request' | 'response' | 'input', ref: DiagnosticArtifactRef): boolean {
    const databasePath = resolve(this.root, '..', 'pa.sqlite');
    inspectPath(databasePath);
    if (!existsSync(databasePath)) return false;
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.nlink !== 1) fail('业务数据库路径类型无效，已拒绝读取诊断清理审计。');
    for (const suffix of ['-wal','-shm','-journal']) {
      const sidecar = databasePath + suffix;
      inspectPath(sidecar);
      if (existsSync(sidecar)) {
        const state = lstatSync(sidecar);
        if (!state.isFile() || state.nlink !== 1) fail('业务数据库附属路径无效，已拒绝读取诊断清理审计。');
      }
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const hasTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get();
      if (!hasTable) return false;
      const rows = database.prepare("SELECT plan_json FROM research_retention_runs WHERE status IN ('pending','done')").all();
      const expectedPath = `diagnostics/calls/${callId}/${name}.json`;
      for (const row of rows) {
        const plan = JSON.parse(String(row.plan_json)) as { candidates?: unknown };
        if (!Array.isArray(plan.candidates)) continue;
        for (const candidate of plan.candidates) {
          if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as { files?: unknown }).files)) continue;
          for (const file of (candidate as { files: unknown[] }).files) {
            if (!file || typeof file !== 'object') continue;
            const entry = file as { path?: unknown; kind?: unknown; sha256?: unknown; bytes?: unknown };
            if (entry.kind === 'diagnostic' && entry.path === expectedPath && entry.sha256 === ref.sha256 && entry.bytes === ref.bytes) return true;
          }
        }
      }
      return false;
    } finally { database.close(); }
  }

  private persistCall(database: DatabaseSync, record: DiagnosticCallRecord): void {
    database.prepare(`INSERT INTO calls(call_id,job_id,task_id,trace_id,record_json) VALUES (?,?,?,?,?)
      ON CONFLICT(call_id) DO UPDATE SET record_json=excluded.record_json`).run(record.callId, record.jobId ?? null,
      record.taskId ?? null, record.traceId, JSON.stringify(record));
  }

  private saveArtifact(callId: string, name: string, data: Buffer): DiagnosticArtifactRef {
    const directory = join(this.root, 'calls', callId);
    privateDirectory(directory);
    const relative = `calls/${callId}/${name}.json`;
    immutableWrite(join(directory, `${name}.json`), data);
    return { path: relative, sha256: digest(data), bytes: data.length };
  }

  private appendEvent(database: DatabaseSync, context: DiagnosticContext, phase: string, event: string,
    details?: Record<string, unknown>, callId?: string): void {
    for (const value of [phase, event]) {
      if (typeof value !== 'string' || !value.length || value.length > 512) fail('诊断阶段或事件名称无效。');
    }
    const entry: DiagnosticEvent = { ...this.context(context), id: randomUUID(), at: new Date().toISOString(),
      phase, event, ...(details === undefined ? {} : { details }), ...(callId === undefined ? {} : { callId }) };
    if (callId !== undefined && !UUID.test(callId)) fail('诊断 callId 必须是有效的 UUID v4。');
    const data = this.encode(entry, MAX_EVENT_BYTES);
    const safe = JSON.parse(data.toString()) as DiagnosticEvent;
    const file = join(this.root, 'events', `${entry.at.slice(0, 10)}.jsonl`);
    inspectPath(file);
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) fail('诊断事件文件类型或链接数量无效。');
      chmodSync(file, 0o600);
      appendFileSync(fd, Buffer.concat([data, Buffer.from('\n')]));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    database.prepare('INSERT INTO events(id,call_id,job_id,task_id,trace_id,event_json) VALUES (?,?,?,?,?,?)')
      .run(safe.id, safe.callId ?? null, safe.jobId ?? null, safe.taskId ?? null, safe.traceId, data.toString());
  }

  startCall(spec: DiagnosticCallSpec, request: unknown, replayInput?: unknown): string {
    return this.guard(() => {
      const context = this.context(spec);
      if (!['chat', 'memory', 'search'].includes(spec.kind)) fail('诊断调用种类无效。');
      const captureLevel = spec.captureLevel ?? 'sdk-normalized';
      if (!['sdk-normalized', 'http-json'].includes(captureLevel)) fail('诊断捕获层级无效。');
      if (spec.contextCalibration !== undefined && !validContextCalibration(spec.contextCalibration)) fail('诊断上下文校准元数据无效。');
      for (const value of [spec.provider, spec.model, spec.phase]) {
        if (typeof value !== 'string' || !value.length || value.length > 512) fail('诊断模型或阶段无效。');
      }
      const requestData = this.encode(request, DIAGNOSTIC_MAX_ARTIFACT_BYTES);
      const inputData = replayInput === undefined ? undefined : this.encode(replayInput, DIAGNOSTIC_MAX_ARTIFACT_BYTES);
      const callId = randomUUID();
      return this.withDatabase(true, database => {
        const at = new Date().toISOString();
        const record: DiagnosticCallRecord = { ...context, callId, kind: spec.kind, provider: this.clean(spec.provider) as string,
          model: this.clean(spec.model) as string, phase: this.clean(spec.phase) as string, status: 'started', createdAt: at, updatedAt: at,
          captureLevel, billedUsage: null, requestRef: this.saveArtifact(callId, 'request', requestData),
          ...(spec.contextCalibration === undefined ? {} : { contextCalibration: structuredClone(spec.contextCalibration) }),
          ...(inputData === undefined ? {} : { inputRef: this.saveArtifact(callId, 'input', inputData) }) };
        this.persistCall(database, record);
        this.appendEvent(database, context, record.phase, 'call_started', { captureLevel: record.captureLevel }, callId);
        return callId;
      }, () => fail('诊断索引无法创建。'));
    });
  }

  saveResponse(callId: string, message: unknown): void {
    this.guard(() => {
      if (!UUID.test(callId)) fail('诊断 callId 必须是有效的 UUID v4。');
      const data = this.encode(message, DIAGNOSTIC_MAX_ARTIFACT_BYTES);
      this.withDatabase(true, database => {
        const record = this.getCall(database, callId);
        const ref = this.saveArtifact(callId, 'response', data);
        if (record.responseRef && record.responseRef.sha256 !== ref.sha256) fail('模型响应证据已存在且内容不同。');
        record.responseRef = ref;
        record.updatedAt = new Date().toISOString();
        const safe = JSON.parse(data.toString()) as unknown;
        if (safe && typeof safe === 'object' && 'usage' in safe) {
          const usage = (safe as { usage: unknown }).usage;
          if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
            const counters: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(usage)) {
              if (/^(?:input|output|total|cacheRead|cacheWrite|inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|prompt_tokens|completion_tokens|input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|total_tokens|reasoning_tokens)$/.test(key)
                && typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
              if (key === 'cost' && value && typeof value === 'object' && !Array.isArray(value)) {
                counters.cost = Object.fromEntries(Object.entries(value).filter(([costKey, cost]) =>
                  /^(input|output|cacheRead|cacheWrite|total)$/.test(costKey) && typeof cost === 'number' && Number.isFinite(cost)));
              }
            }
            record.usage = counters;
            record.usageSource = record.captureLevel === 'http-json' ? 'provider-json' : 'sdk-normalized';
          }
        }
        this.persistCall(database, record);
      }, () => fail('诊断调用不存在。'));
    });
  }

  event(context: DiagnosticContext, phase: string, event: string, details?: Record<string, unknown>, callId?: string): void {
    this.guard(() => this.withDatabase(true, database => this.appendEvent(database, context, phase, event, details, callId),
      () => fail('诊断索引无法创建。')));
  }

  finishCall(callId: string, status: 'completed' | 'failed' | 'unknown', phase: string, details?: Record<string, unknown>): void {
    this.guard(() => {
      if (!UUID.test(callId) || !['completed', 'failed', 'unknown'].includes(status)) fail('诊断调用或状态无效。');
      if (typeof phase !== 'string' || !phase.length || phase.length > 512) fail('诊断阶段无效。');
      this.withDatabase(true, database => {
        const record = this.getCall(database, callId);
        record.status = status;
        record.phase = this.clean(phase) as string;
        record.updatedAt = new Date().toISOString();
        this.persistCall(database, record);
        this.appendEvent(database, record, record.phase, `call_${status}`, details, callId);
      }, () => fail('诊断调用不存在。'));
    });
  }

  private query<T>(table: 'calls' | 'events', filter: DiagnosticFilter = {}): T[] {
    return this.guard(() => {
      const limit = filter.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('诊断查询 limit 必须在 1 到 10000 之间。');
      const clauses: string[] = [], values: string[] = [];
      for (const [key, column] of [['callId', 'call_id'], ['jobId', 'job_id'], ['taskId', 'task_id'], ['traceId', 'trace_id']] as const) {
        const value = filter[key];
        if (value !== undefined) {
          if (typeof value !== 'string' || (key === 'callId' && !UUID.test(value))) fail('诊断查询标识无效。');
          clauses.push(`${column}=?`); values.push(value);
        }
      }
      return this.withDatabase(false, database => {
        const column = table === 'calls' ? 'record_json' : 'event_json';
        return database.prepare(`SELECT ${column} FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT ?`)
          .all(...values, limit).map(row => JSON.parse(String(row[column])) as T);
      }, () => []);
    });
  }

  calls(filter: DiagnosticFilter = {}): DiagnosticCallRecord[] { return this.query('calls', filter); }
  events(filter: DiagnosticFilter = {}): DiagnosticEvent[] { return this.query('events', filter); }

  /** Apply calibration scope/eligibility before the bound, so active rooms cannot evict other rooms' samples. */
  calibrationCalls(key: string, limit = 100): DiagnosticCallRecord[] {
    return this.guard(() => {
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) fail('诊断上下文校准 key 必须是有效的 SHA256。');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('诊断查询 limit 必须在 1 到 10000 之间。');
      return this.withDatabase(false, database => {
        const samples: DiagnosticCallRecord[] = [];
        let bytes = 0;
        const rows = database.prepare(`SELECT record_json FROM calls
        WHERE json_extract(record_json, '$.contextCalibration.key') = ?
          AND json_extract(record_json, '$.status') = 'completed'
          AND json_extract(record_json, '$.kind') = 'chat'
          AND json_extract(record_json, '$.usageSource') = 'sdk-normalized'
        ORDER BY rowid DESC LIMIT ?`).iterate(key, limit);
        // v2 records contain finer fingerprints. Do not materialize 100 large
        // records when the estimator retains only eight successful samples.
        for (const row of rows) {
          const json = String(row.record_json);
          const size = Buffer.byteLength(json, 'utf8');
          if (bytes + size > 16 * 1024 * 1024) continue;
          const record = JSON.parse(json) as DiagnosticCallRecord;
          if (!validContextCalibration(record.contextCalibration) || record.contextCalibration.key !== key
            || normalizedInputTokens(record.usage) === undefined) continue;
          samples.push(record); bytes += size;
          if (samples.length >= Math.min(8, limit)) break;
        }
        return samples;
      }, () => []);
    });
  }

  artifact(callId: string, name: 'request' | 'response' | 'input'): unknown {
    return this.guard(() => {
      if (!UUID.test(callId) || !names.has(name)) fail('诊断证据标识或名称无效。');
      return this.withDatabase(false, database => {
        const record = this.getCall(database, callId);
        const ref = record[`${name}Ref`];
        if (!ref) fail('诊断证据不存在。');
        if (ref.path !== `calls/${callId}/${name}.json` || !/^[0-9a-f]{64}$/.test(ref.sha256)
          || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > DIAGNOSTIC_MAX_ARTIFACT_BYTES) fail('诊断证据引用无效。');
        if (this.artifactExpired(callId, name, ref)) fail(RETENTION_NOTICE);
        let data: Buffer;
        try { data = safeRead(join(this.root, 'calls', callId, `${name}.json`), DIAGNOSTIC_MAX_ARTIFACT_BYTES); }
        catch (error) {
          // Cleanup commits its manifest before unlinking. Recheck after a failed read
          // to classify the narrow commit/read race without guessing from ENOENT.
          try { if (this.artifactExpired(callId, name, ref)) fail(RETENTION_NOTICE); } catch (auditError) {
            if (auditError instanceof DiagnosticPersistenceError && auditError.message === RETENTION_NOTICE) throw auditError;
          }
          throw error;
        }
        if (data.length !== ref.bytes || digest(data) !== ref.sha256) fail('诊断证据哈希或长度不一致，已拒绝重放。');
        return JSON.parse(data.toString());
      }, () => fail('诊断调用不存在。'));
    });
  }
}
