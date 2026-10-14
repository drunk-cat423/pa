// Deterministic model protocol fixture, not a test of language understanding.
let callSequence = 0;
export function companionReply(body, fallback = '记住了。') {
  if (body.messages.at(-1)?.role === 'tool') return {
    delta: { role: 'assistant', content: fallback }, finishReason: 'stop',
  };
  const last = body.messages.findLast(message => message.role === 'user');
  const raw = typeof last?.content === 'string' ? last.content : last?.content?.map(block => block.text ?? '').join('') ?? '';
  let text = raw;
  try { text = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)).currentMessage?.text ?? raw; } catch {}
  const enabled = body.tools?.some(tool => tool.function?.name === 'update_profile');
  if (enabled && /^(?:请)?(?:你)?记(?:住|一下)|^\/self\s|^我现在可以接受|^以后(?:你的|叫我|请你叫我|回复)/u.test(text)) {
    const content = text.replace(/^(?:请)?(?:你)?记(?:住|一下)(?:一下)?[\s，,:：。]*|^\/self\s+/u, '').replace(/[。！!]+$/, '');
    const target = /^(?:以后)?(?:你的|你以后|你叫|你可以叫|你的名字)|^(?:以后)?pa指|^以后回复/u.test(content) ? 'ai_self' : 'sender';
    return { delta: { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${++callSequence}`,
      type: 'function', function: { name: 'update_profile', arguments: JSON.stringify({ target, content,
        sourceType: target === 'sender' && /^(?:我|以后叫我|以后请你叫我)/u.test(content) ? 'self' : 'third_party' }) } }] }, finishReason: 'tool_calls' };
  }
  return { delta: { role: 'assistant', content: fallback }, finishReason: 'stop' };
}
