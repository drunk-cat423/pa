/** Only application-authored descriptions may enter persisted diagnostics. */
export class MemoryProviderError extends Error {
  constructor(readonly code: 'model_length' | 'model_request' | 'model_empty' | 'model_json' | 'model_contract',
    message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'MemoryProviderError';
  }
}

export function memoryFailure(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : '';
  let code = 'unexpected';
  let detail = '未分类异常；调用结果可能未知，需人工检查后重试。';
  if (error instanceof MemoryProviderError) {
    code = error.code;
    const descriptions = { model_length: '模型输出截断。', model_request: '模型请求未完成，调用结果可能未知。',
      model_empty: '模型未返回正文。', model_json: '模型正文不是有效JSON。', model_contract: '模型返回结构不符合约定。' };
    detail = descriptions[error.code] + (error.httpStatus === undefined ? '' : ` HTTP ${error.httpStatus}。`);
  } else if (error instanceof Error && error.name === 'ObsoletePersonalMemoryError') {
    code = 'obsolete_personal_memory'; detail = '个人长期事件协议已过期；固定输入与进度已保留，需操作者处理。';
  } else if (error instanceof Error && error.name === 'MemoryInputTooLargeError') {
    code = 'input_too_large'; detail = '输入超出模型窗口，尚未提交模型。';
  } else if (/版本冲突|输入版本/.test(message)) {
    code = 'profile_conflict'; detail = '画像或人物绑定版本冲突。';
  } else if (message === 'budget' || message === '后台模型调用预算已用完或正在关闭。') {
    code = 'budget'; detail = '后台调用预算不足或正在关闭。';
  } else if (message === 'closed' || message === '后台调用已取消。' || (error instanceof Error && error.name === 'AbortError')) {
    code = 'cancelled_or_timeout'; detail = '调用已取消或超时，结果可能未知。';
  } else if (/租约/.test(message)) {
    code = 'lease'; detail = '任务租约失效。';
  } else if (phase === 'validate') {
    // Validation errors are application-authored; report a fixed category, never model/user values.
    code = /遗漏|覆盖/.test(message) ? 'coverage' : /来源|证据|引用|自述/.test(message) ? 'evidence'
      : /画像|人物|档案/.test(message) ? 'profile_contract' : 'output_contract';
    detail = '模型提案未通过结构、来源或完整覆盖检查。';
  } else if (phase === 'commit') {
    code = 'commit'; detail = '整理结果未提交；原文、固定批次和检查点已保留。';
  }
  const safeDetails = new Set([
    '记忆输出必须包含结构化数组。', '记忆输出正文无效。', '记忆输出引用了输入以外的消息。',
    '人物事实无效。', '人物来源类型无效。', '人物事实不能输出分类字段。', '人物事实时间无效。',
    '人物事实必须引用有效原始真人消息。', '人物事实缺少本人自述或有效原始依据。',
    '记忆输出数量过大。', 'Topic无效。', '人物片段身份无效。', '人物片段话题索引无效。',
    '人物画像版本或结构无效。', '只能归档已捕获且保留来源的人物待整理条目。',
    '整理遗漏了真人消息。', '忽略项只能引用真人消息。', '群聊不生成独立群摘要。',
    '自我画像缺少输入快照。', '自我档案产物结构无效。', '自我档案产物结构或输入版本无效。',
    '自我档案必须引用原始真人来源。', '自我档案只能归档已捕获且保留来源的待整理建议。',
    '自我档案产物超过完整画像容量上限，请缩短正文或来源列表。',
    '整理结果未覆盖所有真人消息。', '无价值消息归属无效。', '后台整理检查点损坏。',
    '后台检查点来源不匹配。', '长期事件归档必须在原子片段保留已捕获的来源。',
    '长期事件归档必须保留已捕获原子片段来源。',
    '长期事件待整理来源不能写入人物画像。',
    'Topic来源必须属于当前会话。',
  ]);
  if (safeDetails.has(message)) detail = message;
  return `[${code}] phase=${phase}; ${detail}`;
}
