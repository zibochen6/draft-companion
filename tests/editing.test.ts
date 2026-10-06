import { describe, expect, it } from 'vitest';
import { bodyStart, candidateAfter, hashText, parseEdit, replaceExact } from '../src/editing';
import type { Candidate } from '../src/types';

describe('candidate parsing and original character protection', () => {
  it.each(['', '{', '[]', '{"replacement":"稿"}', '{"explanation":"x","replacement":1,"notes":[]}', '{"explanation":"x","replacement":"","notes":[]}', '{"explanation":"x","replacement":"稿","notes":[3]}', '{"explanation":"x","replacement":"稿","notes":[],"path":"elsewhere.md"}'])('rejects unsafe response %s', value => expect(() => parseEdit(value)).toThrow());
  it('accepts exact object and complete outer JSON fence without trimming replacement', () => {
    const result = parseEdit('```json\n{"explanation":"仅衔接","replacement":"  中文 😀\\n","notes":[]}\n```');
    expect(result.replacement).toBe('  中文 😀\n');
  });
  it('protects frontmatter, BOM and CRLF, including only YAML files', () => {
    const yaml = '\uFEFF---\r\ntitle: 测试\r\n---\r\n';
    expect(bodyStart(yaml + '文章')).toBe(yaml.length);
    expect(bodyStart(yaml)).toBe(yaml.length);
    expect(bodyStart('文章\n---\n')).toBe(0);
    expect(() => bodyStart('---\ntitle: 未完成')).toThrow('未闭合');
  });
  it('preserves every character outside a mixed Chinese/emoji selection', () => {
    const before = '---\r\ntitle: 示例\r\n---\r\n[[双链]]\r\n中文 English 😀\n下一行\n![[图片.png]]\n```js\nlet x = 1;\n```';
    const from = before.indexOf('中文'), to = before.indexOf('\n![[图片');
    const result = replaceExact(before, from, to, '新 Chinese 🚀\n另一行');
    expect(result.slice(0, from)).toBe(before.slice(0, from));
    expect(result.slice(from + '新 Chinese 🚀\n另一行'.length)).toBe(before.slice(to));
  });
  it('rejects tampered baselines, YAML selections, empty replacements and unclosed code', () => {
    const base = '---\na: 1\n---\n正文\n';
    const candidate: Candidate = { id: 'c', requestId: 'r', documentId: 'd', sessionId: 's', path: 'a.md', scope: 'body', from: bodyStart(base), to: base.length, baseline: base, baselineHash: hashText(base), explanation: '', notes: [], replacement: '```js\n内容', state: 'ready', deletion: false };
    expect(() => candidateAfter(candidate)).toThrow('围栏');
    expect(() => candidateAfter({ ...candidate, from: 0, replacement: '内容' })).toThrow('frontmatter');
    expect(() => candidateAfter({ ...candidate, replacement: '' })).toThrow('空候选');
    expect(() => candidateAfter({ ...candidate, baselineHash: 'bad' })).toThrow('校验');
    expect(candidateAfter({ ...candidate, replacement: '', deletion: true })).toBe(base.slice(0, bodyStart(base)));
  });
});
