import { describe, expect, it } from 'vitest';
import { parseTopicItems } from '../src/topics';

describe('topic Markdown source parsing', () => {
  it('preserves copied whitespace, CRLF, source spans, formatting and independent duplicate titles', () => {
    const source = '# 工作\r\n\r\n- [\u00a0] **同名**（日期）— 描述。｜ https://example.com/a\r\n- [X] **同名** — [资料](https://example.com/b) [[本地资料]]\r\n';
    const items = parseTopicItems(source, 'opaque_doc');
    expect(items).toHaveLength(2); expect(items[0]!.title).toBe('同名'); expect(items[1]!.title).toBe('同名');
    expect(items[0]!.checked).toBe(false); expect(items[1]!.checked).toBe(true);
    expect(items[0]!.section).toBe('工作'); expect(items[0]!.description).toContain('描述');
    expect(items[0]!.links).toEqual(['https://example.com/a']);
    expect(items[1]!.links).toEqual(['https://example.com/b', '[[本地资料]]']);
    expect(items[0]!.ref).not.toBe(items[1]!.ref); expect(items[0]!.ref).not.toContain('同名');
    for (const item of items) {
      expect(source.slice(item.from, item.to)).toBe(item.raw);
      expect(source.slice(item.statusFrom - 1, item.statusTo + 1)).toMatch(/^\[[ \u00a0Xx]\]$/);
      expect(item.raw.endsWith('\r\n')).toBe(true);
    }
    expect(source[items[0]!.statusFrom]).toBe('\u00a0');
  });
  it('excludes nested, quoted, indented-code, fenced-code, YAML and HTML tasks', () => {
    const source = '---\nvalue: yes\n- [ ] YAML伪任务\n---\n# 总区\n## 分区\n- [ ] 主选题\n  - [ ] 子任务\n\n    - [ ] 缩进代码\n\n```markdown\n- [ ] 围栏伪任务\n```\n\n~~~~\n- [ ] 波浪围栏伪任务\n~~~~\n\n> - [ ] 引用任务\n\n<!--\n- [ ] HTML伪任务\n-->\n\n* [x] 第二项\n';
    const items = parseTopicItems(source, 'opaque_doc');
    expect(items.map(item => item.title)).toEqual(['主选题', '第二项']); expect(items[0]!.section).toBe('总区 / 分区');
    expect(items[0]!.raw).toContain('子任务');
  });
  it('recognizes top-level list indentation and NBSP separators without accepting unsupported status marks', () => {
    const source = '  -\u00a0[ ]\u00a0缩进选题\n\n1. [ ] 顺序选题\n2. [-] 未支持状态\n\n- [/] 未支持状态\n- [ ]缺少分隔空白\n';
    expect(parseTopicItems(source, 'opaque_doc').map(item => item.title)).toEqual(['缩进选题', '顺序选题']);
    expect(parseTopicItems('---\n未闭合\n- [ ] 不安全\n', 'opaque_doc')).toEqual([]);
  });
});
