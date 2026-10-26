// Minimal anonymized reproductions of recorded incidents, not a production-data export.
// Original names/IDs/private context remain in .local/server-audit-20261026/.
export const speakerSwapIncident = {
  date: '2026-10-24',
  evidence: '.local/server-audit-20261026/snapshot.json',
  source: '我之前用的免费模型插件8个小时才写了几行代码',
  question: '真的假的 opencode里的claude是啥型号',
  wrongAnswer: '你之前那个“8 小时写几行”的插件，大概率不是模型差，而是池子的并发和排队太挤。',
  context: {
    roomType: 'group', currentSender: { senderId: 'questioner', personId: 'person-questioner', senderName: '提问者' },
    currentQuestion: '真的假的 opencode里的claude是啥型号',
    sources: [{ id: 'other-message', role: 'user', senderId: 'other', personId: 'person-other', senderName: '群友甲',
      text: '我之前用的免费模型插件8个小时才写了几行代码' }],
  },
};

export const currentOpinionIncident = {
  date: '2026-10-24',
  evidence: '.local/server-audit-20261026/snapshot.json',
  question: 'opencode go订阅计划口碑怎么样，现在？速度是不是很慢我听说？',
  // Reproduce the unsupported assertion, without claiming that its external facts were verified false.
  unverifiedAnswer: '先给结论：opencode 的 Go 计划是“低价试用口碑很好、速度和稳定性被吐槽最多”的那类产品。',
};

// Four real responses omitted f44; one replaced f44 but also omitted f24.
// This fixture retains their reference structure, not private profile prose.
export const profileOmissionIncidents = [44, 44, 44, 44, 24].map((omitted, index) => ({
  id: `profile-omission-${index + 1}`, omitted,
  proposal: { ...(index === 1 ? { type: 'json_object' } : {}), facts: Array.from({ length: 46 }, (_, n) => n).flatMap(n => {
    if (index === 4 && n === 24) return [{ content: '已脱敏的使用统计描述', sources: ['m0'], replaces: ['f44'] }];
    if (n === 44) return [];
    return [{ keep: `f${n}` }];
  }) },
}));
