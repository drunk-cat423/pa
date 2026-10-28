// Deterministic protocol response for the mandatory channel preparation phase.
export function conversationMessages(body) {
  return body.messages?.filter(message => {
    const content = typeof message.content === 'string' ? message.content
      : message.content?.map(block => block.text ?? '').join('') ?? '';
    return message.role !== 'user' || !content.startsWith('[PA本轮控制｜应用生成]\n');
  }) ?? [];
}

export function currentMessage(body) {
  const user = conversationMessages(body).findLast(message => message.role === 'user');
  const raw = typeof user?.content === 'string' ? user.content
    : user?.content?.map(block => block.text ?? '').join('') ?? '';
  try { return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)).currentMessage; } catch { return undefined; }
}

export function isPreparationRequest(body) {
  return body.tool_choice?.type === 'function' && body.tool_choice?.function?.name === 'prepare_turn';
}

export function preparationDelta(id, plan = { intent: 'question', mode: 'standard', updates: [] }) {
  const prepared={grounding:{freshness:'stable',experienceRefs:[]},...plan};
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: {
    name: 'prepare_turn', arguments: JSON.stringify(prepared),
  } }] };
}

export function totalModelCalls(requests, planningRequests) {
  return requests.length + planningRequests.length;
}
