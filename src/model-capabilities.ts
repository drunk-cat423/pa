import type { PaConfig } from './config.js';

type ModelConfig = Pick<PaConfig, 'provider' | 'model'>;

export function isBailianDeepSeek(config: ModelConfig): boolean {
  return config.provider === 'bailian'
    && (config.model === 'deepseek-v4.1-flash-1017' || config.model === 'deepseek-v4.1-flash');
}

export function supportsImageInput(config: ModelConfig): boolean {
  return (config.provider === 'deepseek' && config.model === 'deepseek-flash') || isBailianDeepSeek(config);
}

/** Keep provider controls identical in admission estimates and final wire payloads. */
export function applyModelPayload(config: ModelConfig, payload: Record<string, unknown>,
  options: { thinking: boolean; maxTokens: number }): Record<string, unknown> {
  if (!isBailianDeepSeek(config)) return payload;
  const controlled: Record<string, unknown> = { ...payload, enable_thinking: options.thinking, max_tokens: options.maxTokens };
  delete controlled.thinking;
  delete controlled.max_completion_tokens;
  if (options.thinking) controlled.reasoning_effort = 'high';
  else delete controlled.reasoning_effort;
  return controlled;
}
