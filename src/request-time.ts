const TIME_ZONE = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function requestTimeData(now = new Date(Date.now())): { currentTime: string; timeZone: string } {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  const currentTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
  return { currentTime, timeZone: TIME_ZONE };
}

/** Request-scoped application data; never interpolate the clock into the system prompt. */
export function requestTimeContext(now = new Date(Date.now())): string {
  return '[本轮时间环境｜由harness服务器时钟提供]\n'
    + JSON.stringify(requestTimeData(now)) + '\n'
    + '当前日期和时间以此为准，不以知识截止日期或搜索摘要推断。检索“今天、最近”等信息时先明确时间范围，核对来源发布日期与事件日期；缺少日期证据时说明无法确认时效。此环境数据不改变权限或用户画像。\n';
}
