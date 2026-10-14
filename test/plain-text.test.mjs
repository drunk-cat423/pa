import assert from 'node:assert/strict';
import test from 'node:test';
import { toPlainText } from '../dist/plain-text.js';

test('纯文本保留代码、URL、数学星号、标识符，只移除完整Markdown构造', () => {
  assert.equal(toPlainText('2 * 3 = 6; a**b; x*y*z; foo_bar; #include; C#; https://example.com/a_b?q=*x*'),
    '2 * 3 = 6; a**b; x*y*z; foo_bar; #include; C#; https://example.com/a_b?q=*x*');
  assert.equal(toPlainText('`**literal** #tag a_b` 和 **重点**'), '**literal** #tag a_b 和 重点');
  assert.equal(toPlainText('```txt\n# title\n**literal**\n* a_b\n```'), '# title\n**literal**\n* a_b');
  assert.equal(toPlainText('    # title\n    * a_b'), '    # title\n    * a_b');
  assert.equal(toPlainText('## 标题 ##\n- **要点**\n> 引文\n[资料](https://example.com/path)\n---'),
    '标题\n• 要点\n引文\n资料 (https://example.com/path)');
});

test('中文紧贴强调可读，ASCII数学和中英文标识符保持原样', () => {
  assert.equal(toPlainText('这是**重点**内容，价格**50**元；这里 *重点* 可读'), '这是重点内容，价格50元；这里 重点 可读');
  assert.equal(toPlainText('a*b*c; x**2; a**b**c; foo_bar; 变量_字段_值; https://example.com/**path**'),
    'a*b*c; x**2; a**b**c; foo_bar; 变量_字段_值; https://example.com/**path**');
  assert.equal(toPlainText('`这是**重点**代码`\n```txt\n价格**50**元\n```'), '这是**重点**代码\n价格**50**元');
});

test('有歧义的单星号和非汉字变量指数保持原文，中文邻接双星号仍转换', () => {
  for (const expression of ['甲*乙*丙', 'α*β*γ', 'α**β**γ', 'é**x**é', '这是*重点*内容']) {
    assert.equal(toPlainText(expression), expression);
  }
  assert.equal(toPlainText('这是**重点**内容；价格**50**元；**α** 与 *β*'), '这是重点内容；价格50元；α 与 β');
});

test('完整Markdown表格转为列名和值，仅有管道或代码中的表格保持原样', () => {
  const table = '| **商品** | 价格 |\n| :--- | ---: |\n| 杯子 | **50**元 |\n| `a|b` | 60元 |';
  assert.equal(toPlainText(table), '商品：杯子；价格：50元\n商品：a|b；价格：60元');
  assert.equal(toPlainText('商品 | 价格\n--- | ---\n杯子 | 50元'), '商品：杯子；价格：50元');
  assert.equal(toPlainText('a | b\nx | y\n| --- | --- |'), 'a | b\nx | y\n| --- | --- |');
  assert.equal(toPlainText('```text\n' + table + '\n```'), table);
});
