// Deterministic protocol response for the mandatory channel preparation phase.
export function currentMessage(body) {
  const user = body.messages?.findLast(message => message.role === 'user');
  const raw = typeof user?.content === 'string' ? user.content
    : user?.content?.map(block => block.text ?? '').join('') ?? '';
  try { return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)).currentMessage; } catch { return undefined; }
}

export function isPreparationRequest(body) {
  return body.tool_choice?.type === 'function' && body.tool_choice?.function?.name === 'prepare_turn';
}

export function preparationDelta(id, plan = { intent: 'question', mode: 'standard', updates: [] }) {
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: {
    name: 'prepare_turn', arguments: JSON.stringify(plan),
  } }] };
}

export function totalModelCalls(requests, planningRequests) {
  return requests.length + planningRequests.length;
}
