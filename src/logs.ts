import { DiagnosticLog, type DiagnosticCallRecord, type DiagnosticFilter } from './diagnostics.js';
import { parseMemoryResponse } from './memory-provider.js';
import { validateExtract } from './auto-memory.js';
import { assertCurrentMemoryProtocol } from './auto-memory-store.js';
import type { AutoMemoryTaskInput } from './auto-memory-types.js';
import { memoryFailure, memoryFailurePhase } from './memory-diagnostics.js';
import { validateTurnPlan } from './turn-plan.js';
import { parseSearchResponse } from './web-search.js';

export interface ReplayReport {
  callId: string;
  kind: DiagnosticCallRecord['kind'];
  ok: boolean;
  phase: string;
  offline: true;
  networkRequests: 0;
  businessWrites: 0;
  captureLevel: DiagnosticCallRecord['captureLevel'];
  scope: string;
  failure?: string;
  truncated?: boolean;
}

/** Reads immutable, hash-checked evidence only. Never constructs a model, store, worker or tool. */
export function replayDiagnosticCall(log: DiagnosticLog, callId: string): ReplayReport {
  const call = log.calls({ callId })[0];
  if (!call) throw new Error('没有找到该调用的诊断记录。');
  // Always verify the request too; a corrupted bundle is not a valid replay source.
  const request = log.artifact(callId, 'request');
  const response = log.artifact(callId, 'response');
  const report: ReplayReport = { callId, kind: call.kind, ok: false, phase: 'parse', offline: true,
    networkRequests: 0, businessWrites: 0, captureLevel: call.captureLevel,
    scope: call.kind === 'memory' ? '保存输入的解析、结构、来源及覆盖校验；不重放提交或当前权限判定'
      : call.kind === 'search' ? '保存搜索响应的解析校验；不联网、不核验来源真实性或当前日期'
      : '模型响应与准备计划的结构校验；不执行工具、不验证当前授权或提交状态' };
  if (call.kind === 'search') {
    const input = log.artifact(callId, 'input') as { maxResults?: unknown };
    try {
      if (!Number.isSafeInteger(input?.maxResults) || Number(input.maxResults) < 1 || Number(input.maxResults) > 100) throw new Error('invalid');
      const parsed = parseSearchResponse(response, Number(input.maxResults));
      report.ok = true; report.truncated = parsed.truncated;
    } catch { report.failure = '保存的搜索响应未通过解析检查；未发送任何请求。'; }
    return report;
  }
  if (call.kind === 'memory') {
    const input = log.artifact(callId, 'input') as AutoMemoryTaskInput;
    try {
      assertCurrentMemoryProtocol(input);
      const proposal = parseMemoryResponse(response, input);
      report.phase = 'validate';
      validateExtract(proposal, input);
      report.ok = true;
    } catch (error) {
      report.phase = memoryFailurePhase(error, report.phase);
      report.failure = memoryFailure(error, report.phase);
    }
    return report;
  }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(response) || !Array.isArray(response.content) || !['stop', 'length', 'toolUse'].includes(String(response.stopReason))) {
    return { ...report, failure: '保存的模型响应未完整结束或结构无效，不能重放为成功。' };
  }
  const toolCalls = response.content.filter(item => object(item) && item.type === 'toolCall');
  const wire = object(request) ? request : {};
  const choice = wire.tool_choice;
  const forcedPrepare = object(choice) && object(choice.function) && choice.function.name === 'prepare_turn';
  report.phase = 'validate';
  try {
    if (forcedPrepare) {
      if (response.stopReason !== 'toolUse' || toolCalls.length !== 1 || !object(toolCalls[0]) || toolCalls[0].name !== 'prepare_turn') {
        throw new Error('准备阶段必须返回唯一prepare_turn。');
      }
      validateTurnPlan(toolCalls[0].arguments);
    } else if (toolCalls.length) {
      if (wire.tool_choice === 'none' || response.stopReason !== 'toolUse') throw new Error('工具调用与保存的请求阶段不符。');
      const tools = Array.isArray(wire.tools) ? wire.tools : [];
      const allowed = new Set(tools.flatMap(tool => object(tool) && object(tool.function) ? [tool.function.name] : []));
      if (toolCalls.some(tool => !object(tool) || !allowed.has(tool.name) || !object(tool.arguments))) {
        throw new Error('工具调用名称或参数结构不符合保存请求。');
      }
    } else if (response.stopReason === 'toolUse' || !response.content.some(item => object(item) && item.type === 'text' && typeof item.text === 'string' && item.text.trim().length)) {
      throw new Error('模型没有返回可用正文。');
    }
    report.ok = true;
    report.truncated = response.stopReason === 'length';
  } catch { report.failure = '响应或工具计划未通过保存请求的结构检查；未执行任何操作。'; }
  return report;
}

export function queryDiagnostics(log: DiagnosticLog, filter: DiagnosticFilter = {}, content = false) {
  const calls = log.calls(filter);
  const events = log.events(filter);
  const limit = filter.limit ?? 100;
  return { calls: calls.map(call => {
    const { contextCalibration, ...record } = call;
    return { ...record,
      ...(contextCalibration ? { contextCalibration: content ? contextCalibration : {
        version: contextCalibration.version, key: contextCalibration.key,
        requestBytes: contextCalibration.footprint.bytes,
        blockCount: contextCalibration.footprint.blocks.reduce((sum, block) => sum + block.count, 0),
      } } : {}),
      ...(content ? { artifacts: {
        request: log.artifact(call.callId, 'request'),
        ...(call.responseRef ? { response: log.artifact(call.callId, 'response') } : {}),
        ...(call.inputRef ? { input: log.artifact(call.callId, 'input') } : {}),
      } } : {}),
    };
  }), events, mayBeTruncated: calls.length >= limit || events.length >= limit };
}
