import { parseMemoryRequest } from '../../dist/memory-service.js';

// Deterministic protocol fixture only. parseMemoryRequest selects a request for
// the test; this does not assert that the language model can classify intent.
export function memoryAssessmentResponse(payload, { reply = '记住了。', decision } = {}) {
  const messages = payload.messages ?? [];
  const system = [payload.systemPrompt, ...messages.filter(message => message.role === 'system').map(message => message.content)]
    .filter(Boolean).join('\n');
  if (!system.includes('记忆更新判断模块')) return undefined;
  const user = messages.findLast(message => message.role === 'user');
  let input;
  try { input = JSON.parse(user?.content ?? ''); } catch { return undefined; }
  if (!input || typeof input.text !== 'string' || Object.keys(input).length !== 1) return undefined;
  if (decision) return JSON.stringify({ save: true, target: decision.target, content: decision.content,
    ...(decision.field ? { field: decision.field } : {}), reply });
  const request = parseMemoryRequest(input.text);
  const save = request?.type === 'ai_self_update' || request?.type === 'self_update';
  if (!save) return JSON.stringify({ save: false, target: 'sender', content: '', reply: '这次没有保存。' });
  const target = request.type === 'ai_self_update' ? 'ai_self' : 'sender';
  return JSON.stringify({ save: true, target, content: request.content, ...(target === 'sender' && request.field ? { field: request.field } : {}), reply });
}
