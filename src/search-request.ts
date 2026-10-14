// Eligibility comes only from the current sender's own text, never history/quotes/profile.
export function explicitWebSearchQuery(text: string): string | undefined {
  const input = text.trim();
  const prefix = input.match(/^(?:\/search\s+|(?:请|麻烦)?(?:你)?(?:帮我|帮忙)?(?:上网|联网)?(?:搜索一下|搜索|搜一下|搜一搜|搜|查一下|查一查|查询一下)\s*[:：，,]?\s*|search\s+(?:for\s+)?)/iu);
  const query = prefix ? input.slice(prefix[0].length).trim() : undefined;
  return query && query.length <= 500 && /[\p{L}\p{N}]/u.test(query) && !/[\r\n]/.test(query) ? query : undefined;
}

export function explicitWebFetchUrl(text: string): string | undefined {
  const input = text.trim();
  if (/^https?:\/\/[^\s<>"']+$/u.test(input)) return input.length <= 2048 ? input : undefined;
  // "搜索…URL" remains search-only, even when the query contains a link.
  if (!/^(?:请|麻烦)?(?:你)?(?:帮我|帮忙)?(?:打开|读取|抓取|读一下|读下|看一下|看下|看看|看一看|总结(?:一下)?(?:这个|这篇)?(?:网页|页面|文章|链接)?)/u.test(input)) return undefined;
  const urls = input.match(/https?:\/\/[^\s<>"'，。！？；）)]+/gu);
  return urls?.length === 1 && urls[0]!.length <= 2048 ? urls[0] : undefined;
}
