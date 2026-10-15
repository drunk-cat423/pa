/** Stable for a configured model; no per-turn values enter the cached prefix. */
export function outputLengthGuidance(maxTokens: number): string {
  const target = Math.max(1, Math.floor(maxTokens * 0.6));
  return `输出硬上限为${maxTokens} tokens；正文目标不超过${target} tokens，留余量完整收尾。`
    + '先结论后重点，省略重复和冗长列举。确有尚未展开的细节时，末尾可邀用户继续追问；不要每次机械附加邀请或展示token预算。';
}
