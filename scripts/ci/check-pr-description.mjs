import { readFileSync } from 'node:fs';

const headings = ['原来怎样', '本次改了什么', '改前和改后的差别', '验收标准与结果'];
const chinese = /\p{Script=Han}/u;

function check({ title, body }) {
  const errors = [];
  if (typeof title !== 'string' || !chinese.test(title)) errors.push('标题需要包含中文说明。');
  const sections = new Map();
  let current;
  let fence;
  for (const line of (typeof body === 'string' ? body : '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) {
      fence = marker[1];
      continue;
    }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    const heading = /^ {0,3}#{1,2}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = /^ {0,3}##\s/.test(line) ? heading[1].replace(/\s+#+$/, '') : undefined;
      if (headings.includes(current) && !sections.has(current)) sections.set(current, []);
    } else if (sections.has(current)) {
      sections.get(current).push(line);
    }
  }
  for (const heading of headings) {
    if (!sections.has(heading)) errors.push(`缺少“## ${heading}”。`);
    else if (!chinese.test(sections.get(heading).join('\n'))) errors.push(`“${heading}”需要填写中文正文。`);
  }
  return errors;
}

try {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/ci/check-pr-description.mjs <GitHub 事件 JSON>');
  const event = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!event.pull_request) throw new Error('输入缺少 pull_request。');
  const errors = check(event.pull_request);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PR 中文标题和四项说明已填写。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
